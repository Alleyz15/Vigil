import { eq } from "drizzle-orm";
import { EpcisEvent, epcsOf } from "@/lib/epcis";
import { couriers, parcels } from "@/lib/db/schema";
import type { VigilDb } from "@/lib/db/client";
import type { NonceLedger } from "@/lib/ledger";
import type { Verdict } from "@/lib/ledger/types";
import { runInconsistencyEngine } from "@/lib/engine";
import { runPatternEngine } from "@/lib/pattern";
import { runGate } from "@/lib/gate";
import {
  assembleEngineInput,
  assembleGateInput,
  assemblePatternInput,
  coverageLine,
  loadActiveMandate,
  mergeResolutions,
} from "@/lib/assemble";
import { persistEvent, persistExplanation, persistVerdict } from "@/lib/assemble/persist";
import { explainVerdict, planTools } from "@/lib/llm";
import type { LlmProvider, LlmTelemetry } from "@/lib/llm";
import { verificationKeys, verifyCredential } from "@/lib/credential";
import type { Credential, VerificationResult } from "@/lib/credential";
import type { EngineInput } from "@/lib/engine/types";
import type { PatternInput } from "@/lib/pattern/types";
import type { GateInput } from "@/lib/gate/types";
import type { AgentContext, Node } from "./context";

/**
 * The eight node implementations.
 *
 * WHERE THE I/O IS. Nodes read the database and write the ledger; the modules
 * they call (lib/engine, lib/pattern, lib/gate) do not. Everything that reaches
 * for a row happens here or in lib/assemble, which is what makes the verdict a
 * pure function of assembled inputs rather than of whatever the database
 * happened to contain at the moment a rule ran.
 *
 * STILL STUBBED, deliberately: `plan` and `explain` (they arrive with the LLM),
 * and `external_context` (weather arrives with Open-Meteo). Each is marked STUB.
 */

export type NodeDeps = {
  db: VigilDb;
  ledger: NonceLedger;
  /** Injected so tests are not at the mercy of the wall clock. */
  now: () => Date;
  /**
   * The LLM seam. Absent means no model is available, which is the normal case
   * today. Whatever this returns, it CANNOT change a verdict — see the parity
   * test in machine.test.ts. It shapes tool selection and prose only.
   */
  llm?: AgentLlm;
  /**
   * The credential presented alongside this handoff.
   *
   * A SIDECAR, never part of the EPCIS event. Embedding it would make a
   * co-signed resubmission a different payload under the same eventID, which
   * the ledger would rightly abort as EVENT_ID_REUSE — so co-signing would
   * freeze the courier for co-signing. See CLAUDE.md.
   */
  credential?: Credential;
  /**
   * Overrides the operator public key from the environment. Tests inject one so
   * they never touch process.env; production leaves it unset and keys.ts reads
   * the environment.
   */
  operatorPublicKey?: string;
  /** Window overrides, for experiments. */
  windows?: { patternHours?: number; shiftHours?: number };
  /**
   * Threshold overrides, for the sensitivity sweep.
   *
   * Same shape and purpose as `windows`: an experiment varies these as an
   * independent variable and reads the effect. Nothing in the product sets
   * them, and a rule may still never read a threshold it was not handed.
   */
  thresholds?: {
    engine?: EngineInput["thresholds"];
    pattern?: PatternInput["thresholds"];
    gate?: GateInput["thresholds"];
  };
};

/**
 * The only surface an LLM is ever given.
 *
 * A provider that returns text, and counters. Nothing here can reach a rule, a
 * score or the ledger: `plan` chooses which optional context to gather and
 * `explain` writes prose after the fact. Both are validated above the provider,
 * so a new provider cannot widen what the agent accepts.
 */
export type AgentLlm = {
  provider?: LlmProvider;
  /** Accumulated across a whole experiment run, not reset per call. */
  telemetry?: LlmTelemetry;
  planTimeoutMs?: number;
  explainTimeoutMs?: number;
};

/**
 * A node.
 *
 * ASYNC BECAUSE TWO OF THEM HAVE TO BE. `plan` and `explain` call a model over
 * the network, and `external_context` will call a weather API. Six of the eight
 * are synchronous and stay that way; the signature is widened rather than a
 * second, parallel synchronous pipeline being kept alongside this one. Two
 * pipelines drift, and the one that drifts is always the one with the tests.
 */
export type NodeFn = (ctx: AgentContext, deps: NodeDeps) => void | Promise<void>;

/**
 * 1. parse — raw input to a validated EPCIS event across the five dimensions.
 *
 * A parse failure halts the run. We do not attempt partial recovery: an event we
 * cannot read is an event we cannot reason about, and guessing at its meaning is
 * how a verifier ends up certifying something it never understood.
 */
export const parse: NodeFn = (ctx, deps) => {
  const result = EpcisEvent.safeParse(ctx.input);

  if (!result.success) {
    ctx.parseError = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    ctx.halted = { at: "parse", reason: "EVENT_SCHEMA_INVALID" };
    return;
  }

  const event = result.data;

  // WHEN: the server stamps recordTime. The device authors eventTime; the
  // divergence between the two is a tampering detector we get for free, and it
  // only works if exactly one side authors each value.
  if (!event.recordTime) {
    event.recordTime = deps.now().toISOString();
  } else {
    // The device supplied a value it has no business authoring. Not scored here
    // — scoring is the engine's job — but recorded so the engine can see it.
    ctx.recordTimeSuppliedByClient = true;
  }

  ctx.event = event;
};

/**
 * 2. lookup — resolve the EPC to a parcel, and the claimed courier to a mandate.
 *
 * An unrecognised parcel or courier is NOT a neutral outcome. A scan against an
 * EPC we have never issued is either a data gap or an invention, and both belong
 * in front of an operator, so it is marked high risk here rather than shrugged off.
 */
export const lookup: NodeFn = (ctx, deps) => {
  const event = ctx.event;
  if (!event) return;

  const epc = epcsOf(event)[0];
  if (epc) {
    const row = deps.db.select().from(parcels).where(eq(parcels.epc, epc)).get();
    ctx.parcel = row
      ? {
          epc,
          known: true,
          recipientAddress: row.recipientAddress,
          declaredValueSen: row.declaredValueSen,
          // Both coordinates or neither: half a point is not a location.
          recipientPoint:
            row.recipientLat !== null && row.recipientLng !== null
              ? { latitude: row.recipientLat, longitude: row.recipientLng }
              : undefined,
        }
      : { epc, known: false };
  }

  const claimedCourierId = event["vigil:courierId"];
  if (claimedCourierId) {
    const row = deps.db
      .select()
      .from(couriers)
      .where(eq(couriers.courierId, claimedCourierId))
      .get();

    ctx.courier = row
      ? {
          courierId: row.courierId,
          known: true,
          boundDeviceId: row.boundDeviceId,
          // Needed to verify the courier half of the credential.
          publicKey: row.publicKey,
        }
      : { courierId: claimedCourierId, known: false };

    if (row) {
      // Unreadable authorisation is treated as NO authorisation. A mandate whose
      // JSON will not parse must never become a permissive default.
      const mandate = loadActiveMandate(deps.db, row.courierId, ctx.resolution);
      ctx.mandate = { known: mandate !== undefined, value: mandate };
    }
  }

  if (ctx.parcel?.known === false || ctx.courier?.known === false || !claimedCourierId) {
    ctx.unknownEntityRisk = "high";
  }
};

/**
 * 3. plan — STUB. Select 0-2 optional tools from the closed zod enum.
 *
 * One of exactly two places an LLM will appear. When the LLM is absent, errors,
 * or lite mode is on, the identical deterministic heuristic runs instead — which
 * is why `planFromHeuristic` is recorded rather than hidden. Tool selection can
 * change what CONTEXT the operator is shown. It can never change the verdict.
 */
export const plan: NodeFn = async (ctx, deps) => {
  const outcome = await planTools(ctx, {
    provider: deps.llm?.provider,
    telemetry: deps.llm?.telemetry,
    timeoutMs: deps.llm?.planTimeoutMs,
  });

  ctx.plan = outcome.plan;
  ctx.planFromHeuristic = outcome.fromHeuristic;
  // Recorded rather than hidden: an operator, and experiment 5, can tell a
  // model-chosen context set from a deterministic one.
  ctx.planRejection = outcome.rejection;
};

/**
 * 4. verify — axis 1: single-event inconsistency (H1-H4, I1-I14).
 *
 * The replay check runs FIRST and short-circuits, because a replayed event must
 * not be re-scored — its verdict was decided the first time, and replaying it is
 * how you would launder a second opinion out of the same evidence.
 */
export const verify: NodeFn = (ctx, deps) => {
  const event = ctx.event;
  if (!event) return;

  const checked = deps.ledger.check(event.eventID, event);

  if (checked.status === "duplicate") {
    // A double-tap in a dead spot. Replay the original verdict verbatim.
    ctx.ledger = { status: "noop", seq: checked.seq, verdict: checked.verdict };
    ctx.verdict = checked.verdict;
    ctx.decision = checked.verdict.decision;
    ctx.requiresCosign = checked.verdict.requiresCosign;
    ctx.halted = { at: "verify", reason: "DUPLICATE_NO_OP" };
    return;
  }

  if (checked.status === "reuse") {
    // Same eventID, different content. H4 failed; hard checks are all-or-nothing.
    ctx.ledger = { status: "aborted", code: checked.code };
    ctx.inconsistency = {
      score: 100,
      abortCode: "EVENT_ID_REUSE",
      flags: [
        {
          id: "H4",
          label: "This event ID was already used for different content.",
          points: 100,
          evidence: [{ field: "event.eventID", value: event.eventID }],
        },
      ],
    };
    ctx.decision = "freeze";
    ctx.halted = { at: "verify", reason: "EVENT_ID_REUSE" };
    return;
  }

  const { input, resolution } = assembleEngineInput(deps.db, event, {
    courier: ctx.courier?.known ? ctx.courier : undefined,
    mandate: ctx.mandate?.value,
    thresholds: deps.thresholds?.engine,
  });
  ctx.resolution = mergeResolutions(ctx.resolution, resolution);

  const result = runInconsistencyEngine(input);

  ctx.inconsistency = {
    score: result.score,
    // On an abort there are no I-flags; the hard failures are what happened.
    flags: result.aborted ? result.hardFailures : result.flags,
    abortCode: result.abortCode,
  };
  ctx.engineResult = result;
  ctx.coverage = {
    ...ctx.coverage,
    inconsistency: { ...result.coverage, line: coverageLine(result.coverage) },
  };
};

/**
 * 5. fetch_history — axis 2: per-courier rolling pattern (P1-P5).
 *
 * A SEPARATE AXIS, not more evidence for axis 1. A courier whose every single
 * event is clean but whose distribution is wrong is the case no per-event system
 * can see, and it is the reason the two axes are never summed. See CLAUDE.md.
 */
export const fetchHistory: NodeFn = (ctx, deps) => {
  const event = ctx.event;
  const courierId = ctx.courier?.known ? ctx.courier.courierId : undefined;

  if (!event || !courierId) {
    // No identified courier means no courier to have a pattern. Cold start is
    // the honest answer; a zero would read as evidence of good behaviour.
    ctx.pattern = { score: 0, flags: [], sampleSize: 0 };
    ctx.patternColdStart = true;
    ctx.patternOutcome = {
      coldStart: true,
      coldStartReason: "no identified courier for this event",
      flags: [],
      rawScore: 0,
      score: 0,
      sampleSize: 0,
      coverage: { evaluated: 0, total: 5, notEvaluated: [] },
    };
    return;
  }

  const { input, resolution } = assemblePatternInput(deps.db, courierId, event.eventTime, {
    windowHours: deps.windows?.patternHours,
    thresholds: deps.thresholds?.pattern,
  });
  ctx.resolution = mergeResolutions(ctx.resolution, resolution);

  const outcome = runPatternEngine(input);

  ctx.pattern = { score: outcome.score, flags: outcome.flags, sampleSize: outcome.sampleSize };
  ctx.patternColdStart = outcome.coldStart;
  ctx.patternOutcome = outcome;
  ctx.coverage = {
    ...ctx.coverage,
    pattern: { ...outcome.coverage, line: coverageLine(outcome.coverage) },
  };
};

/**
 * 6. external_context — STUB. Weather / traffic lookup, when `plan` asked for it.
 *
 * Exists to let the system decide NOT to escalate: heavy rain explains a stalled
 * route that otherwise looks like a fabricated one. Evidence that lowers an alarm
 * is as much a result as evidence that raises one.
 */
export const externalContext: NodeFn = (ctx) => {
  if (!ctx.plan?.tools.includes("check_traffic_weather")) return;
  ctx.externalContext = { source: "STUB", summary: "STUB: external context not implemented" };
};

/**
 * 7. gate — where the two axes meet, and the ONLY place a decision is produced.
 *
 * Seals the verdict to the append-only ledger FIRST, then projects it into the
 * database for the console. The ledger is the record of truth; if the two ever
 * disagree the ledger wins, so it must be the one written first.
 */
export const gate: NodeFn = (ctx, deps) => {
  const event = ctx.event;
  if (!event || !ctx.engineResult || !ctx.patternOutcome) return;

  const { input, resolution } = assembleGateInput(deps.db, {
    inconsistency: ctx.engineResult,
    pattern: ctx.patternOutcome,
    courierId: ctx.courier?.known ? ctx.courier.courierId : undefined,
    mandate: ctx.mandate?.value,
    epc: ctx.parcel?.epc,
    now: event.eventTime,
    shiftWindowHours: deps.windows?.shiftHours,
    thresholds: deps.thresholds?.gate,
  });
  ctx.resolution = mergeResolutions(ctx.resolution, resolution);

  const result = runGate(input);

  ctx.gateResult = result;
  ctx.decision = result.decision;
  ctx.requiresCosign = result.requiresCosign;

  // THE CONSTITUTIVE CHECK. The gate has just said whether this handoff needs a
  // co-signature; the credential is now checked against that threshold, BEFORE
  // anything is sealed. See CLAUDE.md.
  const credentialCheck = checkCredential(ctx, deps, result.requiresCosign);
  if (credentialCheck) {
    ctx.credential = credentialCheck.result;

    if (credentialCheck.outcome === "pending") {
      // NOTHING IS SEALED. The handoff is undecided, not refused: the operator
      // has not co-signed yet. Writing a verdict here would record a decision
      // nobody made, and would bind this eventID in the ledger so the co-signed
      // resubmission of the very same event could never be sealed.
      ctx.halted = { at: "gate", reason: "PENDING_COSIGNATURE" };
      ctx.decision = undefined;
      return;
    }

    if (credentialCheck.outcome === "invalid") {
      // A forged or mismatched signature is an ATTACK, and an attack is
      // evidence. This one does get sealed, at the harshest outcome.
      ctx.decision = "freeze";
    }
  }

  const verdict: Verdict = {
    decision: ctx.decision ?? result.decision,
    // Two separate fields, carried through to the sealed record unsummed.
    inconsistencyScore: result.axis.inconsistencyScore,
    patternScore: result.axis.patternScore,
    basis: result.basis,
    requiresCosign: result.requiresCosign,
    flags: [
      ...ctx.engineResult.hardFailures.map((f) => f.id),
      ...ctx.engineResult.flags.map((f) => f.id),
      ...ctx.patternOutcome.flags.map((f) => f.id),
      ...result.limitFlags.map((f) => f.id),
      ...(ctx.credential && !ctx.credential.valid ? ["C1"] : []),
    ],
    ...(ctx.engineResult.abortCode
      ? { abortCode: ctx.engineResult.abortCode }
      : ctx.credential && !ctx.credential.valid
        ? { abortCode: "CREDENTIAL_INVALID" }
        : {}),
  };
  ctx.verdict = verdict;

  const { seq } = deps.ledger.commit(event.eventID, event, verdict);
  ctx.ledger = { status: "recorded", seq };

  // Projection for the operator console. The ledger already holds the truth.
  persistEvent(deps.db, event, ctx.courier?.known ? ctx.courier.courierId : undefined);
  persistVerdict(deps.db, event.eventID, seq, verdict, signaturesOf(deps.credential));
};

/**
 * Check the presented credential against the threshold the gate just set.
 *
 * Returns undefined when there is nothing to check (no credential presented and
 * none required), so a deployment that has not started issuing credentials is
 * unaffected until it does.
 *
 * The two failure modes are deliberately different outcomes:
 *
 *   pending  the credential is valid as far as it goes, but the operator has
 *            not co-signed. Nothing is sealed. The handoff decided nothing, so
 *            it must write nothing.
 *   invalid  a signature was forged, mismatched or unverifiable. Sealed as a
 *            freeze, because an attack is evidence and belongs in the ledger.
 */
function checkCredential(
  ctx: AgentContext,
  deps: NodeDeps,
  cosignRequired: boolean,
): { outcome: "valid" | "pending" | "invalid"; result: VerificationResult } | undefined {
  const event = ctx.event;
  if (!event) return undefined;

  const credential = deps.credential;

  if (!credential) {
    // No credential presented. Only a problem when one was required.
    if (!cosignRequired) return undefined;
    return {
      outcome: "pending",
      result: {
        valid: false,
        cosignRequired,
        validSignatures: [],
        invalidSignatures: [],
        problems: [
          {
            code: "MISSING",
            role: "operator",
            detail: "this handoff requires an operator co-signature and no credential was presented",
          },
        ],
      },
    };
  }

  const result = verifyCredential({
    credential,
    handoff: {
      eventID: event.eventID,
      epc: epcsOf(event)[0] ?? "",
      courierId: ctx.courier?.courierId ?? "",
      mandateId: ctx.mandate?.value?.mandateId ?? "",
    },
    keys: {
      ...verificationKeys(ctx.courier?.publicKey),
      ...(deps.operatorPublicKey ? { operatorPublicKey: deps.operatorPublicKey } : {}),
    },
    cosignRequired,
  });

  if (result.valid) return { outcome: "valid", result };

  // Only a co-signature that is absent — not forged, not mismatched — is a
  // pending handoff. Everything else is an attack.
  const onlyAwaitingOperator =
    !result.subjectMismatch &&
    result.invalidSignatures.length === 0 &&
    result.problems.every((p) => p.code === "MISSING" && p.role === "operator");

  return { outcome: onlyAwaitingOperator ? "pending" : "invalid", result };
}

/**
 * The signatures to record on the console projection.
 *
 * Stored so an operator can see WHO approved a handoff, and so the approval can
 * be re-verified later against the keys on file. The signatures are evidence,
 * not decoration.
 */
function signaturesOf(credential: Credential | undefined) {
  if (!credential) return undefined;
  return {
    courierSignature: credential.signatures.find((s) => s.role === "courier")?.signature,
    operatorSignature: credential.signatures.find((s) => s.role === "operator")?.signature,
    operatorId: credential.signatures.find((s) => s.role === "operator")?.signerId,
  };
}

/**
 * 8. explain — STUB. The second and last place an LLM appears.
 *
 * Its output is written AFTER the verdict is sealed and is never an input to it.
 * When implemented, it is schema-constrained to cite only evidence ids that were
 * actually collected; a citation to an id that does not exist fails closed.
 */
export const explain: NodeFn = async (ctx, deps) => {
  if (!ctx.verdict) return;

  const outcome = await explainVerdict(ctx, {
    provider: deps.llm?.provider,
    telemetry: deps.llm?.telemetry,
    timeoutMs: deps.llm?.explainTimeoutMs,
  });

  ctx.explanation = outcome.explanation;
  ctx.explanationFromFallback = outcome.fromFallback;
  ctx.explanationRejection = outcome.rejection;
  ctx.hallucinatedCitations = outcome.hallucinatedCitations;

  // The verdict was sealed at `gate`. This only attaches prose to it, so a
  // failure here leaves the sealed record and the ledger chain untouched.
  persistExplanation(deps.db, ctx.event!.eventID, outcome.explanation);
};

export const NODE_FNS: Record<Node, NodeFn> = {
  parse,
  lookup,
  plan,
  verify,
  fetch_history: fetchHistory,
  external_context: externalContext,
  gate,
  explain,
};

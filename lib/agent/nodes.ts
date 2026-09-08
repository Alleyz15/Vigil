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
import { persistEvent, persistVerdict } from "@/lib/assemble/persist";
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
  /** Window overrides, for experiments. */
  windows?: { patternHours?: number; shiftHours?: number };
};

/** The only surface an LLM is ever given. Both methods are advisory. */
export type AgentLlm = {
  /** Choose 0-2 tools from the closed enum. Never consulted for a decision. */
  planTools?: (ctx: AgentContext) => { tools: string[]; rationale?: string };
  /** Write the operator's explanation, AFTER the verdict is sealed. */
  explain?: (ctx: AgentContext) => string;
};

export type NodeFn = (ctx: AgentContext, deps: NodeDeps) => void;

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
      ? { courierId: row.courierId, known: true, boundDeviceId: row.boundDeviceId }
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
export const plan: NodeFn = (ctx, deps) => {
  if (deps.llm?.planTools) {
    const proposed = deps.llm.planTools(ctx);
    // STUB: the closed-enum validation lands with the LLM. The seam exists now
    // so the parity test can prove a varying plan moves no verdict.
    ctx.plan = { tools: [], rationale: proposed.rationale };
    ctx.planFromHeuristic = false;
    return;
  }

  ctx.plan = { tools: [], rationale: "STUB: tool selection not implemented" };
  ctx.planFromHeuristic = true;
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
  });
  ctx.resolution = mergeResolutions(ctx.resolution, resolution);

  const result = runGate(input);

  ctx.gateResult = result;
  ctx.decision = result.decision;
  ctx.requiresCosign = result.requiresCosign;

  const verdict: Verdict = {
    decision: result.decision,
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
    ],
    ...(ctx.engineResult.abortCode ? { abortCode: ctx.engineResult.abortCode } : {}),
  };
  ctx.verdict = verdict;

  const { seq } = deps.ledger.commit(event.eventID, event, verdict);
  ctx.ledger = { status: "recorded", seq };

  // Projection for the operator console. The ledger already holds the truth.
  persistEvent(deps.db, event, ctx.courier?.known ? ctx.courier.courierId : undefined);
  persistVerdict(deps.db, event.eventID, seq, verdict);
};

/**
 * 8. explain — STUB. The second and last place an LLM appears.
 *
 * Its output is written AFTER the verdict is sealed and is never an input to it.
 * When implemented, it is schema-constrained to cite only evidence ids that were
 * actually collected; a citation to an id that does not exist fails closed.
 */
export const explain: NodeFn = (ctx, deps) => {
  if (!ctx.verdict) return;

  if (deps.llm?.explain) {
    ctx.explanation = deps.llm.explain(ctx);
    return;
  }

  const coverage = ctx.coverage?.inconsistency?.line ?? "coverage unknown";
  ctx.explanation = `STUB: ${ctx.verdict.decision} (inconsistency ${ctx.verdict.inconsistencyScore}, pattern ${ctx.verdict.patternScore}; ${coverage})`;
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

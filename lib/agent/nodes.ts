import { eq, and } from "drizzle-orm";
import { EpcisEvent, epcsOf, vigilSignalsOf } from "@/lib/epcis";
import { couriers, mandates, parcels } from "@/lib/db/schema";
import type { VigilDb } from "@/lib/db/client";
import type { NonceLedger } from "@/lib/ledger";
import type { AgentContext, Node } from "./context";

/**
 * The eight node implementations.
 *
 * SESSION 1 SCOPE: `parse`, `lookup`, and the ledger check inside `verify` are
 * real. The rest are typed stubs that return placeholder values so the pipeline
 * runs end to end — a stub that returns the right SHAPE is worth more than an
 * unimplemented branch, because the wiring is what gets debugged later.
 *
 * Every stub is marked STUB. None of them silently invent a verdict.
 */

export type NodeDeps = {
  db: VigilDb;
  ledger: NonceLedger;
  /** Injected so tests are not at the mercy of the wall clock. */
  now: () => Date;
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
      const mandate = deps.db
        .select()
        .from(mandates)
        .where(and(eq(mandates.courierId, row.courierId), eq(mandates.status, "active")))
        .get();

      ctx.mandate = mandate
        ? { mandateId: mandate.mandateId, known: true, status: mandate.status }
        : { mandateId: "", known: false };
    }
  }

  if (ctx.parcel?.known === false || ctx.courier?.known === false || !claimedCourierId) {
    ctx.unknownEntityRisk = "high";
  }
};

/**
 * 3. plan — STUB. Select 0-2 optional tools from the closed zod enum.
 *
 * This is one of exactly two places an LLM appears. When the LLM is absent,
 * errors, or lite mode is on, the identical deterministic heuristic runs
 * instead — which is why `planFromHeuristic` is recorded rather than hidden.
 * Tool selection can change what CONTEXT the operator is shown. It can never
 * change the verdict.
 */
export const plan: NodeFn = (ctx) => {
  ctx.plan = { tools: [], rationale: "STUB: tool selection not implemented" };
  ctx.planFromHeuristic = true;
};

/**
 * 4. verify — axis 1: single-event inconsistency (H1-H4, I1-I14).
 *
 * REAL THIS SESSION: the H4 replay check against the nonce ledger.
 * STUBBED: H1-H3 and I1-I14 scoring.
 *
 * The replay check runs first and short-circuits, because a replayed event must
 * not be re-scored — its verdict was decided the first time and replaying it is
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

  // STUB: H1-H3 and I1-I14 land in a later session. Touching the signals here
  // only to keep the shape honest — no score is invented.
  void vigilSignalsOf(event);
  ctx.inconsistency = { score: 0, flags: [] };
};

/**
 * 5. fetch_history — axis 2: per-courier rolling pattern (P1-P5). STUB.
 *
 * This is a SEPARATE AXIS, not more evidence for axis 1. A courier whose every
 * single event is clean but whose distribution is wrong is the case no per-event
 * system can see, and it is the reason the two axes are never summed.
 * See CLAUDE.md before changing this.
 */
export const fetchHistory: NodeFn = (ctx) => {
  ctx.pattern = { score: 0, flags: [], sampleSize: 0 };
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
 * STUB: the orthogonal matrix and the mandate limit/cooldown/co-sign checks land
 * in a later session. It currently commits an `accept` with both scores at zero,
 * so the pipeline runs end to end and the ledger records a real, sealed entry.
 *
 * NEVER let an LLM produce this value.
 */
export const gate: NodeFn = (ctx, deps) => {
  const event = ctx.event;
  if (!event || !ctx.inconsistency || !ctx.pattern) return;

  ctx.decision = "accept"; // STUB
  ctx.requiresCosign = false; // STUB

  ctx.verdict = {
    decision: ctx.decision,
    inconsistencyScore: ctx.inconsistency.score,
    patternScore: ctx.pattern.score,
    flags: [...ctx.inconsistency.flags, ...ctx.pattern.flags].map((f) => f.id),
    ...(ctx.inconsistency.abortCode ? { abortCode: ctx.inconsistency.abortCode } : {}),
  };

  const { seq } = deps.ledger.commit(event.eventID, event, ctx.verdict);
  ctx.ledger = { status: "recorded", seq };
};

/**
 * 8. explain — STUB. The second and last place an LLM appears.
 *
 * When implemented, its output is schema-constrained to cite only evidence IDs
 * that were actually collected; a citation to an ID that does not exist fails
 * closed. The explanation is never an input to the verdict — it is written after
 * the decision is already sealed, and removing it changes nothing but readability.
 */
export const explain: NodeFn = (ctx) => {
  if (!ctx.verdict) return;
  ctx.explanation = `STUB: ${ctx.verdict.decision} (inconsistency ${ctx.verdict.inconsistencyScore}, pattern ${ctx.verdict.patternScore})`;
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

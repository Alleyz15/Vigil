import { canonicalHash } from "@/lib/ledger";
import type { TokenState } from "@/lib/recipient/token";
import type { ToolConsideration } from "@/lib/llm/plan";
import { epcsOf } from "@/lib/epcis";
import type { AgentContext } from "@/lib/agent/context";
import type { BuiltEvent, GeneratedScenario, GeneratedWorld } from "@/lib/generate";
import type { ShipmentMapModel } from "./map-model";
import type { CaseState, OperatorActionName } from "./types";
import { abortKindOf, inboxGroupOf, shortReasonFor, type AbortKind, type InboxGroupId } from "./inbox";

export type HandoffState = CaseState | "accepted";

export type AxisValue = {
  score: number | null;
  evaluable: boolean;
  source: "evaluated" | "cold_start" | "not_evaluated";
  reason: string | null;
};

export type HandoffSummary = {
  eventId: string;
  caseId: string | null;
  scenarioId: string;
  legIndex: number;
  parcel: {
    epc: string;
    /**
     * A waybill when one is on file ANYWHERE in the world, else the EPC's
     * serial — and `idKind` says which, so a view never presents an EPC as if it
     * were a waybill. S4 scans another courier's parcel: the waybill exists, it
     * is just not on this shipment.
     */
    waybillNo: string;
    idKind: "waybill" | "epc";
    onThisShipment: boolean;
  };
  courier: { courierId: string; displayName: string };
  bizStep: string;
  eventTime: string;
  state: HandoffState;
  priority: number;
  reason: string;
  /** A few words for a list, derived from what decided. The sentence stays in `reason`. */
  shortReason: string;
  /** The gate's own matrix cell. Grouping reads this rather than re-comparing a threshold. */
  matrixCell: string | null;
  abort: AbortKind;
  inboxGroup: InboxGroupId;
  /**
   * Whether `state` was COMPUTED by the workbench or SEEDED for the demo.
   *
   * S5's `timed_out` is assigned by scenario id. No liveness timer exists, so a
   * "timed out" badge with nothing behind it tells a viewer the system measured
   * a response window it never measured. The badge carries this and says so.
   */
  stateProvenance: "computed" | "seeded";
  ageMinutes: number;
  decision: string | null;
  sealed: boolean;
  inconsistency: AxisValue;
  pattern: AxisValue;
  coverageLine: string | null;
  gateBasis: string | null;
  requiresCosign: boolean;
  provenance: {
    event: "synthetic";
    attestation: "mocked";
    pattern: "evaluated" | "cold_start" | "not_evaluated";
    explanation: { source: "model" | "fallback" | "unavailable"; modelId: string | null };
  };
};

export type RunView = {
  run: number;
  eventHash: string;
  decision: string | null;
  halted: { at: string; reason: string } | null;
  sealed: boolean;
  /**
   * Which of the ledger's three paths this run took.
   *
   * `sealed` collapses `recorded` and `noop` into one boolean, which is right
   * for the operator's "is there an entry?" question and WRONG for the
   * courier's. A resubmission that no-ops and one that aborts as a reused id
   * are the honest double-tap and the forgery attempt respectively, and the
   * whole point of hashing the canonicalised payload is that we can tell them
   * apart. See CLAUDE.md rule 5.
   */
  ledgerStatus: "recorded" | "noop" | "aborted" | null;
  credential: {
    valid: boolean;
    courierValid: boolean;
    operatorValid: boolean;
    cosignRequired: boolean;
    problems: string[];
  } | null;
  trace: AgentContext["trace"];
};

export type ActionView = {
  action: OperatorActionName;
  note: string | null;
  operatorId: string;
  fromState: string;
  toState: string;
  createdAt: string;
};

export type HandoffDetail = {
  summary: HandoffSummary;
  event: unknown;
  flags: Array<{ id: string; points: number; label: string; evidence: Array<{ field: string; value: unknown }> }>;
  gate: { decision: string | null; matrixCell: string | null; rationale: string | null; cosignReasons: string[] };
  credential: RunView["credential"];
  ledger: { sequence: number | null; chainValid: boolean; entries: number };
  /** The recipient capability for this handoff. Demo affordance; see service.ts. */
  recipientConfirmation: { tokenId: string; state: TokenState } | null;
  /**
   * A mid-route address correction behind this handoff, if there was one.
   *
   * NOT AN ENGINE INPUT. The verdict was reached without it — I10/I11 simply
   * found the scan and the registry disagreeing. This is the independent record
   * that explains WHY they disagreed, and it is the difference between an
   * operator seeing "distance from recipient address" and an operator seeing
   * that the address changed after the parcel was already moving.
   */
  /**
   * What location evidence could not exist for this handoff, and why — online
   * shipments at a point with no registered reference sites. Not an engine
   * input: the engine found the absence on its own. `null` for every seeded and
   * built shipment, whose addresses are in the registry.
   */
  locationEvidence: {
    gap: { code: string; summary: string; detail: string };
    scanSource: "simulation";
    /** The boundary the reference was checked against, as stamped on its snapshot. */
    boundary: { version: string; placeholder: boolean; attribution: string };
  } | null;
  addressCorrection: {
    fromLabel: string;
    toLabel: string;
    correctedAt: string;
  } | null;
  runs: RunView[];
  actions: ActionView[];
  timeline: HandoffSummary[];
  map: ShipmentMapModel;
  /**
   * Every tool the deterministic planner weighed, and why each was or was not
   * taken. Rejected alternatives are part of the answer: an agent that shows
   * only what it chose is asking to be trusted, not offering to be checked.
   */
  planConsidered: ToolConsideration[];
  plan: {
    selectedTools: string[];
    source: "model" | "heuristic" | "unavailable";
    rejection: string | null;
  };
  externalContext: AgentContext["externalContext"] | null;
  reroute: AgentContext["reroute"] | null;
  explanation: {
    text: string | null;
    source: "model" | "fallback" | "unavailable";
    rejection: string | null;
  };
};

export type WorkbenchEntry = {
  scenario: GeneratedScenario;
  world: GeneratedWorld;
  built: BuiltEvent;
  current: AgentContext;
  runs: AgentContext[];
  state: CaseState | null;
  caseId: string | null;
  priority: number;
  reason: string;
  createdAt: string;
  /** Set when the demo assigned `state` rather than the workbench deriving it. */
  stateSource?: "seeded";
};

function suffix(value: string | undefined | null): string {
  return value?.split(":").at(-1)?.replaceAll("_", " ") ?? "unknown step";
}

function axisValues(ctx: AgentContext): Pick<HandoffSummary, "inconsistency" | "pattern"> {
  const engine = ctx.engineResult;
  const pattern = ctx.patternOutcome;
  const inconsistencyEvaluable = Boolean(engine && !engine.aborted && engine.coverage.evaluated > 0);
  const patternEvaluable = Boolean(pattern && !pattern.coldStart);

  return {
    inconsistency: {
      score: engine ? engine.score : null,
      evaluable: inconsistencyEvaluable,
      source: inconsistencyEvaluable ? "evaluated" : "not_evaluated",
      reason: inconsistencyEvaluable
        ? null
        : engine?.aborted
          ? `hard check failed (${engine.abortCode ?? "unknown"})`
          : "single-event evidence was unavailable",
    },
    pattern: {
      score: pattern ? pattern.score : null,
      evaluable: patternEvaluable,
      source: patternEvaluable ? "evaluated" : pattern?.coldStart ? "cold_start" : "not_evaluated",
      reason: patternEvaluable ? null : (pattern?.coldStartReason ?? "pattern evidence was unavailable"),
    },
  };
}

export function runView(ctx: AgentContext, run: number, fallbackEvent: BuiltEvent["event"]): RunView {
  const credential = ctx.credential;
  return {
    run,
    eventHash: canonicalHash(ctx.event ?? fallbackEvent),
    decision: ctx.decision ?? null,
    halted: ctx.halted ? { ...ctx.halted } : null,
    sealed: ctx.ledger?.status === "recorded" || ctx.ledger?.status === "noop",
    ledgerStatus: ctx.ledger?.status ?? null,
    credential: credential
      ? {
          valid: credential.valid,
          courierValid: credential.validSignatures.includes("courier"),
          operatorValid: credential.validSignatures.includes("operator"),
          cosignRequired: credential.cosignRequired,
          problems: credential.problems.map((problem) => `${problem.role}: ${problem.detail}`),
        }
      : null,
    trace: ctx.trace,
  };
}

export function summaryFrom(entry: WorkbenchEntry, nowIso: string): HandoffSummary {
  const ctx = entry.current;
  const event = ctx.event ?? entry.built.event;
  const epc = epcsOf(event)[0] ?? "unknown";
  const onShipment = entry.scenario.parcels.find((candidate) => candidate.epc === epc);
  const inWorld = onShipment ?? entry.world.parcels.find((candidate) => candidate.epc === epc);
  const state: HandoffState = entry.state ?? "accepted";
  const abort = abortKindOf(ctx);
  const matrixCell = ctx.gateResult?.matrixCell ?? null;
  const axes = axisValues(ctx);
  const explanationSource = ctx.explanation
    ? ctx.explanationFromFallback
      ? "fallback"
      : "model"
    : "unavailable";

  return {
    eventId: event.eventID,
    caseId: entry.caseId,
    scenarioId: entry.scenario.id,
    legIndex: entry.built.legIndex,
    parcel: {
      epc,
      waybillNo: inWorld?.waybillNo ?? epc.split(":").at(-1) ?? epc,
      idKind: inWorld ? "waybill" : "epc",
      onThisShipment: Boolean(onShipment),
    },
    courier: {
      courierId: entry.scenario.courier.courierId,
      displayName: entry.scenario.courier.displayName,
    },
    bizStep: suffix(event.bizStep),
    eventTime: event.eventTime,
    state,
    priority: entry.priority,
    reason: entry.reason,
    shortReason: shortReasonFor(ctx),
    matrixCell,
    abort,
    inboxGroup: inboxGroupOf({ abort, state, matrixCell }),
    stateProvenance: entry.stateSource === "seeded" ? "seeded" : "computed",
    ageMinutes: Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(entry.createdAt)) / 60_000)),
    decision: ctx.decision ?? null,
    sealed: ctx.ledger?.status === "recorded" || ctx.ledger?.status === "noop",
    ...axes,
    coverageLine: ctx.coverage?.inconsistency?.line ?? null,
    gateBasis: ctx.verdict?.basis ?? ctx.gateResult?.basis ?? null,
    requiresCosign: ctx.requiresCosign ?? false,
    provenance: {
      event: "synthetic",
      attestation: "mocked",
      pattern: axes.pattern.source,
      explanation: { source: explanationSource, modelId: null },
    },
  };
}

export function flagsFrom(ctx: AgentContext): HandoffDetail["flags"] {
  return [
    ...(ctx.engineResult?.hardFailures ?? []),
    ...(ctx.engineResult?.flags ?? []),
    ...(ctx.patternOutcome?.flags ?? []),
    ...(ctx.gateResult?.limitFlags ?? []),
  ].map((flag) => ({
    id: flag.id,
    points: flag.points,
    label: flag.label,
    evidence: flag.evidence.map(({ field, value }) => ({ field, value })),
  }));
}

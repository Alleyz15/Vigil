import { canonicalHash } from "@/lib/ledger";
import { epcsOf } from "@/lib/epcis";
import type { AgentContext } from "@/lib/agent/context";
import type { BuiltEvent, GeneratedScenario, GeneratedWorld } from "@/lib/generate";
import type { ShipmentMapModel } from "./map-model";
import type { CaseState, OperatorActionName } from "./types";

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
  parcel: { epc: string; waybillNo: string };
  courier: { courierId: string; displayName: string };
  bizStep: string;
  eventTime: string;
  state: HandoffState;
  priority: number;
  reason: string;
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
  runs: RunView[];
  actions: ActionView[];
  timeline: HandoffSummary[];
  map: ShipmentMapModel;
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
  const parcel = entry.scenario.parcels.find((candidate) => candidate.epc === epc);
  const state: HandoffState = entry.state ?? "accepted";
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
    parcel: { epc, waybillNo: parcel?.waybillNo ?? epc.split(":").at(-1) ?? epc },
    courier: {
      courierId: entry.scenario.courier.courierId,
      displayName: entry.scenario.courier.displayName,
    },
    bizStep: suffix(event.bizStep),
    eventTime: event.eventTime,
    state,
    priority: entry.priority,
    reason: entry.reason,
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

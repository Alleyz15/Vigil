import { canonicalHash } from "@/lib/ledger";
import { describeVerification } from "@/lib/credential";
import type { TokenState } from "@/lib/recipient/token";
import type { ToolConsideration } from "@/lib/llm/plan";
import { epcsOf } from "@/lib/epcis";
import type { AgentContext } from "@/lib/agent/context";
import type { BuiltEvent, GeneratedScenario, GeneratedWorld } from "@/lib/generate";
import type { ShipmentMapModel } from "./map-model";
import type { CaseState, OperatorActionName } from "./types";
import { abortKindOf, inboxGroupOf, shortReasonFor, type AbortKind, type InboxGroupId } from "./inbox";
import { INCONSISTENCY_RULES } from "@/lib/engine/inconsistency";
import { PATTERN_RULES } from "@/lib/pattern/rules";

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
  patternCoverageLine?: string | null;
  /** Operator-detail timeline label. Omitted on list projections that do not own route context. */
  locationLabel?: string | null;
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

export type RouteLocationView = {
  /** The best available human-readable line, with `source` saying whose line it is. */
  label: string;
  source: "registered" | "sender_claim" | "geocoder_search" | "geocoder_reverse" | "coordinate";
  /** Present for a confirmed arbitrary point; null for cached registered locations. */
  coordinate: string | null;
  /** Kept separate when a geocoder label is also present. */
  senderClaim: string | null;
};

export type CheckView = {
  id: string;
  label: string;
  status: "triggered" | "clear" | "not_evaluated";
  reason: string | null;
  points: number;
};

const CHECK_LABELS: Record<string, string> = {
  I1: "GPS against registered cell and WiFi",
  I2: "Claimed movement against accelerometer",
  I3: "Implied travel speed",
  I4: "Device clock ahead of server",
  I5: "Delayed or offline receipt",
  I6: "Scanning handset against courier binding",
  I7: "Mock-location provider reported",
  I8: "Device integrity attestation",
  I9: "Photo time against scan time",
  I10: "Distance from delivery reference",
  I11: "Severe distance from delivery reference",
  I12: "Proof-of-delivery evidence",
  I13: "Courier working-time mandate",
  I14: "Battery use against claimed movement",
  I15: "OTP claim against verifier record",
  I16: "Attestation against device enrollment",
  P1: "Delivery burst rate",
  P2: "Recipient disputes against fleet baseline",
  P3: "Repeated near-threshold score shape",
  P4: "Scan clustering against recipient addresses",
  P5: "Recurring contradiction type",
};

function axisChecks(
  ids: string[],
  flags: NonNullable<AgentContext["engineResult"]>["flags"],
  notEvaluated: Array<{ id: string; reason: string }>,
): CheckView[] {
  const flagsById = new Map(flags.map((flag) => [flag.id, flag]));
  const missingById = new Map(notEvaluated.map((item) => [item.id, item.reason]));
  return ids.map((id) => {
    const flag = flagsById.get(id);
    if (flag) {
      return { id, label: CHECK_LABELS[id] ?? flag.label, status: "triggered", reason: flag.label, points: flag.points };
    }
    const reason = missingById.get(id);
    if (reason) return { id, label: CHECK_LABELS[id] ?? id, status: "not_evaluated", reason, points: 0 };
    return { id, label: CHECK_LABELS[id] ?? id, status: "clear", reason: null, points: 0 };
  });
}

/** The complete three-state rule ledger shown to an operator; missing is never clean. */
export function checksFrom(ctx: AgentContext): HandoffDetail["checks"] {
  const engine = ctx.engineResult;
  const pattern = ctx.patternOutcome;
  const inconsistencyIds = INCONSISTENCY_RULES.flatMap((rule) => rule.ids);
  const patternIds = PATTERN_RULES.flatMap((rule) => rule.ids);
  return {
    singleEvent: axisChecks(
      inconsistencyIds,
      [...(engine?.hardFailures ?? []), ...(engine?.flags ?? [])],
      engine?.coverage.notEvaluated ?? inconsistencyIds.map((id) => ({ id, reason: "single-event engine did not run" })),
    ),
    pattern: axisChecks(
      patternIds,
      pattern?.flags ?? [],
      pattern?.coverage.notEvaluated ?? patternIds.map((id) => ({ id, reason: "pattern engine did not run" })),
    ),
  };
}

export type ShipmentRouteView = {
  origin: RouteLocationView | null;
  destination: RouteLocationView;
  custody?: {
    originDepot: RouteLocationView;
    destinationDepot: RouteLocationView;
  };
};

export type HandoffDetail = {
  supportingEvidence?: import("./operations-types").EvidenceRequestView[];
  archivedEvidenceCount?: number;
  canApprove?: boolean;
  summary: HandoffSummary;
  /** The shipment endpoints when this workbench owns their source records. */
  route: ShipmentRouteView | null;
  event: unknown;
  checks: { singleEvent: CheckView[]; pattern: CheckView[] };
  flags: Array<{ id: string; points: number; label: string; evidence: Array<{ field: string; value: unknown }> }>;
  /** A ledger rejection that stopped the engine before its normal flag sources existed. */
  abortEvidence: {
    code: "EVENT_ID_REUSE";
    ruleId: "H4";
    eventId: string;
    boundPayloadHash: string;
    submittedPayloadHash: string;
  } | null;
  gate: { decision: string | null; matrixCell: string | null; rationale: string | null; cosignReasons: string[] };
  /** Raw mandate inputs shown beside the gate-produced reasons; never re-decides the condition. */
  cosignPolicyEvidence: Array<{
    kind: "parcel_value_over_sen" | "recipient_address_not_in_scope" | "inconsistency_score_at_least" | "pattern_score_at_least";
    actual: number | string | null;
    threshold: number | null;
  }>;
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
  /** The run whose result owns the displayed verdict. Retries remain in `runs`. */
  authoritativeRun: RunView;
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
    failoverReason?: string;
    selectedTools: string[];
    rationale: string | null;
    source: "model" | "heuristic" | "unavailable";
    rejection: string | null;
    modelId: string | null;
    runtimeReason: string | null;
  };
  externalContext: AgentContext["externalContext"] | null;
  toolResults: NonNullable<AgentContext["toolResults"]>;
  reroute: AgentContext["reroute"] | null;
  explanation: {
    failoverReason?: string;
    text: string | null;
    source: "model" | "fallback" | "unavailable";
    rejection: string | null;
    modelId: string | null;
    runtimeReason: string | null;
    citations: string[];
  };
  /** Hash of the one sealed deterministic verdict both explanation views read. */
  verdictHash: string | null;
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
    patternCoverageLine: ctx.coverage?.pattern?.line ?? null,
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
  const flags = [
    ...(ctx.engineResult?.hardFailures ?? []),
    ...(ctx.engineResult?.flags ?? []),
    // H4 is produced by the ledger before the engine runs. It still arrives as
    // structured inconsistency evidence, and an absent engine result must not
    // make the read model call that evidence empty.
    ...(ctx.engineResult ? [] : (ctx.inconsistency?.flags ?? [])),
    ...(ctx.patternOutcome?.flags ?? []),
    ...(ctx.gateResult?.limitFlags ?? []),
  ].map((flag) => ({
    id: flag.id,
    points: flag.points,
    label: flag.label,
    evidence: flag.evidence.map(({ field, value }) => ({ field, value })),
  }));

  if (ctx.verdict?.abortCode === "CREDENTIAL_INVALID" && ctx.credential && !ctx.credential.valid) {
    flags.push({
      id: "C1",
      points: 0,
      label: describeVerification(ctx.credential),
      evidence: [
        ...ctx.credential.problems.map((problem) => ({
          field: `credential.${problem.role}`,
          value: problem.detail,
        })),
        ...(ctx.credential.subjectMismatch
          ? [{ field: "credential.subject", value: ctx.credential.subjectMismatch }]
          : []),
      ],
    });
  }

  return [...new Map(flags.map((flag) => [flag.id, flag])).values()];
}

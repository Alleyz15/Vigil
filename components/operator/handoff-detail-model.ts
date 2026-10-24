import { NODES, type TraceFrame } from "@/lib/agent/context";
import type { ToolEndFrame } from "@/lib/agent/trace";
import type { HandoffState, RunView } from "@/lib/workbench";
import type { OperatorActionName } from "@/lib/workbench/types";
import type { Evidence } from "@/lib/engine";

export type DetailTone = "accepted" | "pending" | "alert" | "resolved";

export function primaryFlagCard(flags: Array<{
  id: string;
  label: string;
  points: number;
  evidence: Evidence[];
}>): { code: string; title: string; evidence: Evidence | null } | null {
  const flag = [...flags].sort((a, b) => b.points - a.points || a.id.localeCompare(b.id))[0];
  return flag
    ? { code: flag.id, title: flag.label, evidence: flag.evidence[0] ?? null }
    : null;
}

export function resolvedActionMessage(sealed: boolean): string {
  return sealed
    ? "This work item is resolved. The sealed deterministic verdict remains unchanged."
    : "This work item is resolved. No verdict was sealed; the operator disposition closed the work item.";
}

export function operatorActionAvailability(input: {
  state: HandoffState;
  rerouteAvailable: boolean;
  canApprove?: boolean;
  sealed?: boolean;
}): Record<OperatorActionName, boolean> {
  const resolved = input.state.startsWith("resolved_") || input.state === "accepted";
  return {
    approve: !resolved && !input.sealed && (input.canApprove ?? input.state === "awaiting_cosignature"),
    reject: !resolved,
    request_evidence: !resolved && input.state !== "awaiting_evidence",
    propose_reroute: !resolved && input.rerouteAvailable,
    escalate: !resolved,
  };
}

export function ledgerReferencePresentation(sequence: number | null): {
  label: string;
  copyable: boolean;
} {
  return sequence === null
    ? { label: "Not written", copyable: false }
    : { label: `Ledger #${sequence}`, copyable: true };
}

function axisCoverage(line: string, axis: "single-event" | "pattern"): string {
  const match = /^(\d+) of (\d+) checks evaluable$/.exec(line);
  return match ? `${match[1]} of ${match[2]} ${axis} checks` : `${axis} coverage: ${line}`;
}

function money(sen: number): string {
  return new Intl.NumberFormat("en-MY", { style: "currency", currency: "MYR" }).format(sen / 100);
}

type CosignPolicyEvidence = {
  kind: "parcel_value_over_sen" | "recipient_address_not_in_scope" | "inconsistency_score_at_least" | "pattern_score_at_least";
  actual: number | string | null;
  threshold: number | null;
};

export function cosignConditionPresentation(item: CosignPolicyEvidence): {
  label: string;
  status: "Triggered" | "Not triggered" | "Unavailable" | "Evaluated by gate";
  actualLabel: string;
  actual: string;
  trigger: string;
  triggered: boolean | null;
} {
  if (item.kind === "recipient_address_not_in_scope") {
    return {
      label: "Recipient scope condition",
      status: "Evaluated by gate",
      actualLabel: "Recipient address",
      actual: String(item.actual ?? "Unavailable"),
      trigger: "Co-signature triggers outside the assigned route",
      triggered: null,
    };
  }

  const actual = typeof item.actual === "number" ? item.actual : null;
  const threshold = item.threshold;
  const unavailable = actual === null || threshold === null;
  const isValue = item.kind === "parcel_value_over_sen";
  const triggered = unavailable ? null : isValue ? actual > threshold : actual >= threshold;

  return {
    label: isValue
      ? "Parcel value condition"
      : item.kind === "inconsistency_score_at_least"
        ? "Inconsistency condition"
        : "Pattern condition",
    status: triggered === null ? "Unavailable" : triggered ? "Triggered" : "Not triggered",
    actualLabel: isValue ? "Declared value" : "Actual score",
    actual: actual === null ? "Unavailable" : isValue ? money(actual) : String(actual),
    trigger: threshold === null
      ? "Trigger unavailable"
      : isValue
        ? `Co-signature triggers above ${money(threshold)}`
        : `Co-signature triggers at \u2265 ${threshold}`,
    triggered,
  };
}

export function acceptanceExplanation(input: {
  decision: string | null;
  inconsistencyScore: number | null;
  inconsistencyCoverage: string | null;
  patternScore: number | null;
  patternCoverage: string | null;
  declaredValueSen: number | null;
  valueThresholdSen: number | null;
  courierSignatureValid: boolean;
  requiresCosign: boolean;
}): string | null {
  if (input.decision !== "accept" || !input.inconsistencyCoverage || !input.patternCoverage) return null;

  const measured = `${axisCoverage(input.inconsistencyCoverage, "single-event")} and ${axisCoverage(input.patternCoverage, "pattern")} were evaluable.`;
  const findings = [
    input.inconsistencyScore === 0 ? "No single-event contradiction was found" : null,
    input.patternScore === 0 ? "recent courier behaviour was normal" : null,
    input.declaredValueSen !== null && input.valueThresholdSen !== null && input.declaredValueSen <= input.valueThresholdSen
      ? `and ${money(input.declaredValueSen)} did not trigger the ${money(input.valueThresholdSen)} value condition`
      : null,
  ].filter((part): part is string => Boolean(part));
  const credential = input.courierSignatureValid
    ? `The courier signature was valid; ${input.requiresCosign ? "an operator signature was also required." : "no operator signature was required."}`
    : "The courier signature was not valid.";

  return `${measured} ${findings.join(", ")}. ${credential}`;
}

export function attemptHistoryLabel(run: Pick<RunView, "ledgerStatus" | "decision">): {
  title: string;
  detail: string;
} {
  if (run.ledgerStatus === "noop") {
    return {
      title: "Identical resubmission",
      detail: "Original sealed verdict reused. No additional ledger record written.",
    };
  }
  if (run.ledgerStatus === "recorded") {
    return { title: "Verdict sealed", detail: "A new append-only ledger record was written." };
  }
  if (run.ledgerStatus === "aborted") {
    return { title: "Submission aborted", detail: "The attempt was recorded as abort evidence." };
  }
  return {
    title: run.decision ? `Decision: ${run.decision}` : "No decision sealed",
    detail: "This attempt did not write a ledger record.",
  };
}

export function planPresentation(input: {
  source: "model" | "heuristic" | "unavailable";
  selectedTools: string[];
  runtimeReason: string | null;
  rejection: string | null;
}): string {
  if (input.source === "model") {
    const selection = input.selectedTools.length > 0
      ? input.selectedTools.join(", ")
      : "no optional tools";
    return `The model selected ${selection}. Its free-text planning rationale is not used as evidence; the auditable deterministic comparison appears below.`;
  }
  if (input.source === "heuristic") {
    const reason = input.rejection ?? input.runtimeReason;
    return reason
      ? `Model plan was not used: ${reason}. The deterministic heuristic selected the optional context tools shown below.`
      : "The deterministic heuristic selected the optional context tools shown below.";
  }
  return input.rejection ?? input.runtimeReason ?? "No planning result was available.";
}

export function citationTarget(citation: string): { href: string; evidenceId: string | null } {
  if (citation === "ledger") return { href: "#seal-and-ledger", evidenceId: null };
  if (citation === "decision" || citation === "credential" || citation === "coverage") {
    return { href: "#decision-and-credential", evidenceId: null };
  }
  return { href: "#evidence-details", evidenceId: citation };
}

export function shouldShowEvidenceDetails(input: {
  flagCount: number;
  hasAddressCorrection: boolean;
  /** A location with no registered reference sites. Worth saying even when nothing fired. */
  hasLocationGap?: boolean;
}): boolean {
  return input.flagCount > 0 || input.hasAddressCorrection || Boolean(input.hasLocationGap);
}

export function detailStatusMessage(input: {
  state: HandoffState;
  sealed: boolean;
  stateProvenance?: "computed" | "seeded";
}): {
  title: string;
  detail: string;
  tone: DetailTone;
} {
  if (!input.sealed && input.state === "awaiting_cosignature") {
    return {
      title: "Waiting for operator co-signature",
      detail: "Nothing was sealed. Approval reruns the identical event with a complete credential.",
      tone: "pending",
    };
  }
  if (!input.sealed && input.state === "timed_out") {
    // "Response window expired" asserts a window was measured. When the demo
    // seeded this state, none was — so the sentence says what is true instead.
    return input.stateProvenance === "seeded"
      ? {
          title: "Timed out — seeded for the demo",
          detail:
            "Nothing was sealed. This state was assigned when the demo was built; no liveness timer measured a response window. The handoff still needs an operator disposition.",
          tone: "alert",
        }
      : {
          title: "Response window expired",
          detail: "Nothing was sealed. The handoff still needs an operator disposition.",
          tone: "alert",
        };
  }
  if (input.state === "accepted") {
    return {
      title: "Automatically accepted",
      detail: "The deterministic gate accepted this handoff and its credential sealed.",
      tone: "accepted",
    };
  }
  return {
    title: input.state.replaceAll("_", " "),
    detail: input.sealed
      ? "The deterministic verdict is sealed. Operator actions record disposition without rewriting it."
      : "No verdict was sealed in this run.",
    tone: input.state.startsWith("resolved_") ? "resolved" : "alert",
  };
}

export type TraceNodeState = {
  node: (typeof NODES)[number];
  status: "pending" | "running" | "done" | "error";
  durationMs: number | null;
  flags: string[];
};

export function traceNodeStates(trace: TraceFrame[]): TraceNodeState[] {
  return NODES.map((node) => {
    const start = trace.find((frame) => frame.type === "tool_start" && frame.node === node);
    const end = trace.find(
      (frame): frame is ToolEndFrame => frame.type === "tool_end" && frame.node === node,
    );
    return {
      node,
      status: end ? (end.error ? "error" : "done") : start ? "running" : "pending",
      durationMs: end?.durationMs ?? null,
      flags: end?.summary?.flags ?? [],
    };
  });
}

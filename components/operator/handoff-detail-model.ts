import { NODES, type TraceFrame } from "@/lib/agent/context";
import type { ToolEndFrame } from "@/lib/agent/trace";
import type { HandoffState } from "@/lib/workbench";
import type { OperatorActionName } from "@/lib/workbench/types";

export type DetailTone = "accepted" | "pending" | "alert" | "resolved";

export function operatorActionAvailability(input: {
  state: HandoffState;
  rerouteAvailable: boolean;
}): Record<OperatorActionName, boolean> {
  const resolved = input.state.startsWith("resolved_") || input.state === "accepted";
  return {
    approve: !resolved && input.state === "awaiting_cosignature",
    reject: !resolved,
    request_evidence: !resolved,
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

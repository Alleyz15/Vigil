import type { CaseState, OperatorActionName } from "./types";

const QUEUE_STATES = new Set<CaseState>(["flagged", "awaiting_cosignature", "timed_out"]);
const TERMINAL_STATES = new Set<CaseState>([
  "resolved_approved",
  "resolved_rejected",
  "resolved_escalated",
]);

export function isQueueState(state: CaseState): boolean {
  return QUEUE_STATES.has(state);
}

/**
 * Transitions operator work, never a verdict. The function intentionally has
 * no Verdict argument or return value: a human disposition cannot rewrite the
 * deterministic fact already sealed by the agent.
 */
export function transitionCase(state: CaseState, action: OperatorActionName): CaseState {
  if (TERMINAL_STATES.has(state)) {
    throw new Error(`case is already resolved (${state})`);
  }

  switch (action) {
    case "approve":
      if (state !== "awaiting_cosignature") {
        throw new Error(`cannot approve a case in ${state}`);
      }
      return "resolved_approved";
    case "reject":
      return "resolved_rejected";
    case "request_evidence":
      return "awaiting_evidence";
    case "propose_reroute":
      return "awaiting_reroute_signatures";
    case "escalate":
      return "resolved_escalated";
  }
}


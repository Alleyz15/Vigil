/**
 * The LLM seam.
 *
 * The model appears in exactly two places — choosing which optional evidence to
 * gather, and writing prose for a human — and neither can move a verdict. That
 * is not a convention: `lib/agent/machine.test.ts` seals verdicts with no model,
 * with fake A and with fake B and requires them byte-identical. See CLAUDE.md.
 */

/** One completion request. Providers implement this and nothing else. */
export type LlmRequest = {
  system: string;
  user: string;
  /** Hard ceiling. A model that has not answered by now is a model that failed. */
  timeoutMs: number;
  /** Low, because both call sites want a decision from a closed set, not prose invention. */
  temperature?: number;
};

/**
 * A provider returns raw text. Parsing, validation and rejection all happen
 * above it, so a new provider cannot accidentally widen what is accepted.
 */
export type LlmProvider = {
  name: string;
  complete: (request: LlmRequest) => Promise<string>;
};

/** Why a model's output was refused. Each is counted separately. */
export type RejectionReason =
  /** The response was not JSON, or did not match the response schema. */
  | "schema_invalid"
  /** A tool name outside the closed enum. */
  | "unknown_tool"
  /** Cited an evidence id that was never collected in this run. */
  | "bad_citation"
  /** Prose asserting an outcome the sealed verdict contradicts. */
  | "decision_contradiction"
  /** The provider threw, timed out, or was unreachable. */
  | "provider_error";

/**
 * Counters, accumulated across a whole run.
 *
 * EXPERIMENT 5 REPORTS THE HALLUCINATION RATE BEFORE AND AFTER ENFORCEMENT, so
 * both numbers have to exist: how often the model was asked, and how often what
 * it produced was refused, broken down by reason. A log line cannot be totalled
 * at the end of a batch; a counter can.
 *
 * Deliberately mutable and injected, so one instance spans an entire experiment
 * rather than resetting per call.
 */
export type LlmTelemetry = {
  plan: { attempts: number; accepted: number; rejected: Record<RejectionReason, number> };
  explain: { attempts: number; accepted: number; rejected: Record<RejectionReason, number> };
};

const emptyReasons = (): Record<RejectionReason, number> => ({
  schema_invalid: 0,
  unknown_tool: 0,
  bad_citation: 0,
  decision_contradiction: 0,
  provider_error: 0,
});

export function createTelemetry(): LlmTelemetry {
  return {
    plan: { attempts: 0, accepted: 0, rejected: emptyReasons() },
    explain: { attempts: 0, accepted: 0, rejected: emptyReasons() },
  };
}

export function recordAttempt(telemetry: LlmTelemetry | undefined, node: "plan" | "explain"): void {
  if (telemetry) telemetry[node].attempts++;
}

export function recordAccepted(telemetry: LlmTelemetry | undefined, node: "plan" | "explain"): void {
  if (telemetry) telemetry[node].accepted++;
}

export function recordRejected(
  telemetry: LlmTelemetry | undefined,
  node: "plan" | "explain",
  reason: RejectionReason,
): void {
  if (telemetry) telemetry[node].rejected[reason]++;
}

/** Total rejections for a node, across every reason. */
export function totalRejected(telemetry: LlmTelemetry, node: "plan" | "explain"): number {
  return Object.values(telemetry[node].rejected).reduce((a, b) => a + b, 0);
}

/** The rate experiment 5 reports: refused outputs over attempts. */
export function rejectionRate(telemetry: LlmTelemetry, node: "plan" | "explain"): number {
  const { attempts } = telemetry[node];
  return attempts === 0 ? 0 : totalRejected(telemetry, node) / attempts;
}

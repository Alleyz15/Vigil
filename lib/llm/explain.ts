import type { AgentContext } from "@/lib/agent/context";
import type { Decision } from "@/lib/ledger/types";
import { describeVerification } from "@/lib/credential";
import { ExplainResponse, extractJson } from "./schemas";
import { EXPLAIN_SYSTEM_PROMPT, explainUserPrompt } from "./prompts";
import {
  type LlmProvider,
  type LlmTelemetry,
  recordAccepted,
  recordAttempt,
  recordRejected,
} from "./types";

/**
 * Node 8: the operator's explanation.
 *
 * Runs AFTER the verdict is sealed and is never an input to it. If everything
 * here fails, the handoff is already decided and recorded; the operator gets a
 * structured flag list instead of prose, which is a degradation in readability
 * and nothing else.
 */

/** Ids a citation may refer to beyond the flags themselves. */
const CONTEXT_IDS = ["decision", "coverage", "ledger", "credential"] as const;

/**
 * The evidence this run actually collected.
 *
 * A citation outside this set is an invention, whatever it looks like. The set
 * is built from what was RECORDED, not from what could have been recorded, so a
 * model cannot cite a rule that never fired.
 */
export function collectEvidenceIds(ctx: AgentContext): Set<string> {
  const ids = new Set<string>(CONTEXT_IDS);

  if (ctx.externalContext?.status === "available") ids.add("weather");

  for (const flag of ctx.engineResult?.hardFailures ?? []) ids.add(flag.id);
  for (const flag of ctx.engineResult?.flags ?? []) ids.add(flag.id);
  for (const flag of ctx.patternOutcome?.flags ?? []) ids.add(flag.id);
  for (const flag of ctx.gateResult?.limitFlags ?? []) ids.add(flag.id);
  for (const id of ctx.verdict?.flags ?? []) ids.add(id);

  return ids;
}

/**
 * Words that would assert an outcome the sealed verdict contradicts.
 *
 * THE ASYMMETRY IS DELIBERATE. A false rejection costs a fallback to the
 * structured flag list — the operator reads a slightly drier page. A false
 * acceptance ships prose telling an operator the handoff was approved when it
 * was frozen. When the two trade off, reject.
 *
 * So this is kept blunt rather than clever: an approving word on a refusing
 * verdict, or a refusing word on an accept.
 */
const APPROVING = ["approved", "accepted", "cleared", "verified as genuine", "no action needed"];
const REFUSING = ["rejected", "refused", "frozen", "denied", "blocked", "escalated"];

const FORBIDDEN_BY_DECISION: Record<Decision, string[]> = {
  // An accepted handoff must not be described as refused.
  accept: REFUSING,
  // A flagged, escalated or frozen handoff must not be described as approved.
  flag: APPROVING,
  escalate: APPROVING,
  freeze: APPROVING,
};

/**
 * Strip negations before looking for a claim word.
 *
 * "not approved" contains "approved", and rejecting it would refuse a correct
 * explanation. Removing the negated form first means only a bare assertion
 * trips the check.
 */
function stripNegations(text: string): string {
  return text
    .replace(/\b(?:not|never|cannot be|could not be|was not|is not|isn't|wasn't|no longer)\s+\w+/gi, " ")
    .toLowerCase();
}

/** The decision word a sealed verdict forbids, if the prose asserts one. */
export function findDecisionContradiction(
  text: string,
  decision: Decision,
): string | undefined {
  const cleaned = stripNegations(text);
  return FORBIDDEN_BY_DECISION[decision].find((word) => cleaned.includes(word));
}

/**
 * The fallback explanation: the flags, rendered.
 *
 * This is what "remove the LLM and only the explanation degrades" means in
 * practice. It is not an error message — it is a complete, accurate account of
 * the verdict, written from the same structured data the model was given.
 */
export function structuredExplanation(ctx: AgentContext): string {
  const verdict = ctx.verdict;
  if (!verdict) return "No verdict was produced for this handoff.";

  const parts: string[] = [];
  parts.push(`Decision: ${verdict.decision}.`);

  const labels = [
    ...(ctx.engineResult?.hardFailures ?? []),
    ...(ctx.engineResult?.flags ?? []),
    ...(ctx.patternOutcome?.flags ?? []),
    ...(ctx.gateResult?.limitFlags ?? []),
  ].map((flag) => `${flag.id}: ${flag.label}`);

  // The credential result is not a Flag - it reaches the verdict as the bare id
  // "C1" - so it has to be rendered from its own source. Without this a frozen
  // handoff whose signature failed reads "No checks raised a concern", which is
  // worse than terse: it is wrong.
  if (ctx.credential && !ctx.credential.valid) {
    labels.push(`C1: ${describeVerification(ctx.credential)}`);
  }

  parts.push(labels.length > 0 ? labels.join(" ") : "No checks raised a concern.");

  // The coverage line is computed once, from the Resolution, and restated here
  // verbatim - never re-derived and never re-worded by a model.
  if (ctx.coverage?.inconsistency?.line) parts.push(`Evidence: ${ctx.coverage.inconsistency.line}.`);
  if (verdict.requiresCosign) parts.push("An operator co-signature is required.");
  if (ctx.externalContext) parts.push(`Corroborating context: ${ctx.externalContext.summary}`);

  return parts.join(" ");
}

export type ExplainArgs = {
  provider?: LlmProvider;
  telemetry?: LlmTelemetry;
  timeoutMs?: number;
  /**
   * REPORT-ONLY MODE. Experiments only; never set by the agent.
   *
   * Counts what WOULD have been rejected and lets it through, so experiment 5
   * can report the hallucination rate before and after enforcement. The "before"
   * number cannot be obtained any other way: with enforcement on, a hallucinated
   * citation never reaches an operator, so its rate is unobservable.
   *
   * `lib/agent/nodes.ts` does not pass this, and a purity test asserts it never
   * does. Turning enforcement off in the product would silently ship prose
   * citing evidence that was never collected.
   */
  enforce?: boolean;
};

export type ExplainOutcome = {
  explanation: string;
  /** True when the structured fallback produced this. */
  fromFallback: boolean;
  /** Why the model's answer was refused, when it was. */
  rejection?: string;
  /** Citations that were not in the collected evidence. Counted by experiment 5. */
  hallucinatedCitations?: string[];
};

/**
 * Ask the model to explain, and refuse anything it cannot back up.
 *
 * Two enforcement gates, both all-or-nothing:
 *   1. every citation must name evidence this run actually collected;
 *   2. the prose must not assert an outcome the sealed verdict contradicts.
 *
 * A failure of either discards the whole explanation. Keeping the summary while
 * dropping a bad citation would let an invented claim ride along inside prose
 * that reads as sourced.
 */
export async function explainVerdict(
  ctx: AgentContext,
  args: ExplainArgs = {},
): Promise<ExplainOutcome> {
  const { provider, telemetry, timeoutMs = 12_000, enforce = true } = args;

  if (!provider || !ctx.verdict) {
    return { explanation: structuredExplanation(ctx), fromFallback: true };
  }

  const allowed = collectEvidenceIds(ctx);
  recordAttempt(telemetry, "explain");

  let raw: string;
  try {
    raw = await provider.complete({
      system: EXPLAIN_SYSTEM_PROMPT,
      user: explainUserPrompt(ctx, [...allowed]),
      timeoutMs,
      temperature: 0.2,
    });
  } catch (err) {
    recordRejected(telemetry, "explain", "provider_error");
    return {
      explanation: structuredExplanation(ctx),
      fromFallback: true,
      rejection: `provider_error: ${(err as Error).message}`,
    };
  }

  let parsed: ExplainResponse;
  try {
    parsed = ExplainResponse.parse(extractJson(raw));
  } catch {
    recordRejected(telemetry, "explain", "schema_invalid");
    return { explanation: structuredExplanation(ctx), fromFallback: true, rejection: "schema_invalid" };
  }

  // FAIL CLOSED ON AN INVENTED CITATION.
  const hallucinated = parsed.citations.filter((id) => !allowed.has(id));
  if (hallucinated.length > 0) {
    recordRejected(telemetry, "explain", "bad_citation");
    // Report-only: counted above, but allowed through so the experiment can
    // measure what enforcement is actually catching.
    if (!enforce) {
      return {
        explanation: [parsed.summary, parsed.nextStep].filter(Boolean).join(" "),
        fromFallback: false,
        rejection: "bad_citation (report-only)",
        hallucinatedCitations: hallucinated,
      };
    }
    return {
      explanation: structuredExplanation(ctx),
      fromFallback: true,
      rejection: "bad_citation",
      hallucinatedCitations: hallucinated,
    };
  }

  const prose = [parsed.summary, parsed.nextStep].filter(Boolean).join(" ");
  const contradiction = findDecisionContradiction(prose, ctx.verdict.decision);
  if (contradiction) {
    recordRejected(telemetry, "explain", "decision_contradiction");
    if (!enforce) {
      return {
        explanation: prose,
        fromFallback: false,
        rejection: `decision_contradiction (report-only): "${contradiction}"`,
      };
    }
    return {
      explanation: structuredExplanation(ctx),
      fromFallback: true,
      rejection: `decision_contradiction: "${contradiction}"`,
    };
  }

  recordAccepted(telemetry, "explain");

  // The coverage line is appended from the Resolution, not taken from the model.
  const coverage = ctx.coverage?.inconsistency?.line;
  return {
    explanation: coverage ? `${prose} (${coverage}.)` : prose,
    fromFallback: false,
  };
}

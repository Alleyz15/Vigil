import { z } from "zod";
import { ToolName } from "@/lib/agent/context";

/**
 * What a model is allowed to return.
 *
 * STRUCTURED OUTPUT IS ACCEPTED OR REJECTED WHOLE, NEVER FILTERED.
 * Dropping the bad members of a response and keeping the rest lets a model
 * launder an invented claim by surrounding it with valid ones — the surviving
 * fragment carries the authority of a response that was, as a whole, wrong.
 * Both schemas below are all-or-nothing on purpose. See CLAUDE.md.
 */

/**
 * The plan node's response.
 *
 * `tools` is the closed enum and nothing else: a model cannot name a step, ask
 * for a shell command, or return free text that gets executed. A member outside
 * the enum fails the parse, and the whole plan is discarded.
 */
export const PlanResponse = z.strictObject({
  tools: z.array(ToolName).max(2),
  /** Shown in the SSE stream only. Never read by the engine. */
  rationale: z.string().max(400).optional(),
});
export type PlanResponse = z.infer<typeof PlanResponse>;

/**
 * The explain node's response.
 *
 * `citations` are checked against the evidence actually collected in this run.
 * The model writes the prose; it does not get to decide what the evidence was.
 */
export const ExplainResponse = z.strictObject({
  /** What an operator reads first. */
  summary: z.string().min(1).max(600),
  /** What to do next, if anything. */
  nextStep: z.string().max(400).optional(),
  /** Evidence ids this explanation rests on. Validated against the run. */
  citations: z.array(z.string().min(1)).max(12),
});
export type ExplainResponse = z.infer<typeof ExplainResponse>;

/**
 * Pull the first JSON object out of a model response.
 *
 * Models wrap JSON in prose and fences no matter what the prompt says. This
 * recovers the object without being lenient about its CONTENTS — whatever comes
 * out still has to satisfy the schema above.
 */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object in the model response");
  }

  return JSON.parse(candidate.slice(start, end + 1));
}

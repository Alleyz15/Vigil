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
 * Normalise the transport wrapper without changing the structured root.
 *
 * Models wrap JSON in prose and fences no matter what the prompt says.
 * Plain JSON and fenced contents are parsed WHOLE, even if the root is an array
 * or a string. The response schema, not this normaliser, decides its validity.
 * Legacy prose wrappers are allowed, but an array cannot shed its outer members.
 */
export function extractJson(raw: string): unknown {
  const candidate = raw.trim();
  // A structured response is never mined for a more convenient inner object,
  // including when the outer JSON is malformed or contains a fence as data.
  if (/^[{["]/.test(candidate)) return JSON.parse(candidate);

  const start = candidate.search(/[[{]/);
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  // A fence inside an enclosing array/object is data, not a transport wrapper.
  if (fenced && (start === -1 || fenced.index! < start)) return JSON.parse(fenced[1].trim());

  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON response in the model response");
  }

  return JSON.parse(candidate.slice(start, end + 1));
}

import { z } from "zod";
import { Decision, VerdictBasis } from "@/lib/ledger/types";
import { NODES } from "./nodes-list";

/**
 * The SSE trace contract.
 *
 * FROZEN FROM SESSION 4. The operator console is built against this shape, and
 * a frontend cannot be written against a moving target. Add optional fields if
 * you must; do not rename or remove one, and do not change a frame's meaning.
 *
 * Four frame types:
 *
 *   tool_start   a node began
 *   tool_end     a node finished, with what it produced
 *   thought      free-text reasoning, for the console only — NEVER read by the
 *                engine, and the only frame an LLM will ever author
 *   result       the run's outcome, emitted once, last
 *
 * Frames are zod-validated on the way out, so a malformed frame fails here
 * rather than in a browser. `seq` is monotonic from 0 and is the ordering
 * authority: SSE delivery order is not something a client should have to trust.
 */

export const NodeName = z.enum(NODES);

/** What a node produced. Present on tool_end; shape depends on the node. */
export const NodeSummary = z.strictObject({
  /** Flag ids produced. Carried by `verify` (I-rules) and `fetch_history` (P-rules). */
  flags: z.array(z.string()).optional(),
  /** The node's axis score, where it computes one. Never a combination of both axes. */
  score: z.number().optional(),
  /** Evidence coverage, so a thin picture is visible next to the score. */
  coverage: z
    .strictObject({
      evaluated: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      /** "8 of 14 checks evaluable" — rendered from the same numbers. */
      line: z.string(),
    })
    .optional(),
  /** Node-specific detail. Free-form because each node reports different things. */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type NodeSummary = z.infer<typeof NodeSummary>;

const FrameBase = {
  /** Monotonic from 0. The ordering authority for the client. */
  seq: z.number().int().nonnegative(),
  at: z.iso.datetime({ offset: true }),
};

export const ToolStartFrame = z.strictObject({
  type: z.literal("tool_start"),
  ...FrameBase,
  node: NodeName,
});

export const ToolEndFrame = z.strictObject({
  type: z.literal("tool_end"),
  ...FrameBase,
  node: NodeName,
  /** Wall time the node took, from the injected clock. */
  durationMs: z.number().nonnegative(),
  summary: NodeSummary.optional(),
  /** Set when the node threw. The run halts; no verdict is produced. */
  error: z.string().optional(),
});

export const ThoughtFrame = z.strictObject({
  type: z.literal("thought"),
  ...FrameBase,
  node: NodeName,
  text: z.string(),
});

/**
 * The run's outcome. Emitted exactly once, last.
 *
 * The two axis scores appear as SEPARATE fields here, as everywhere else. A
 * client must not add them; see CLAUDE.md.
 */
export const ResultFrame = z.strictObject({
  type: z.literal("result"),
  ...FrameBase,
  decision: Decision.optional(),
  basis: VerdictBasis.optional(),
  requiresCosign: z.boolean().optional(),
  inconsistencyScore: z.number().optional(),
  patternScore: z.number().optional(),
  flags: z.array(z.string()),
  /** Set when the run ended early: a parse failure, a replay, a node error. */
  halted: z.strictObject({ at: NodeName, reason: z.string() }).optional(),
});

export const TraceFrame = z.discriminatedUnion("type", [
  ToolStartFrame,
  ToolEndFrame,
  ThoughtFrame,
  ResultFrame,
]);
export type TraceFrame = z.infer<typeof TraceFrame>;
export type ToolStartFrame = z.infer<typeof ToolStartFrame>;
export type ToolEndFrame = z.infer<typeof ToolEndFrame>;
export type ThoughtFrame = z.infer<typeof ThoughtFrame>;
export type ResultFrame = z.infer<typeof ResultFrame>;

/** Serialise one frame as an SSE event. The wire format the console consumes. */
export function toSseMessage(frame: TraceFrame): string {
  return `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
}

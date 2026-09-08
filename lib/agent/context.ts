import { z } from "zod";
import type { EpcisEvent } from "@/lib/epcis";
import type { Decision, Verdict } from "@/lib/ledger/types";

/**
 * The context object the state machine threads through its eight nodes.
 *
 * There is no framework here on purpose. Eight nodes over one typed object is a
 * switch statement; a graph library would add a layer to explain to a judge
 * without removing one from the code.
 */

/** The eight nodes, in execution order. */
export const NODES = [
  "parse",
  "lookup",
  "plan",
  "verify",
  "fetch_history",
  "external_context",
  "gate",
  "explain",
] as const;
export type Node = (typeof NODES)[number];

/**
 * The closed set of optional tools the LLM may select at `plan`.
 *
 * A zod enum, not a string: the model picks from a fixed list or the parse
 * fails. It cannot invent a tool, and it cannot reach anything not named here.
 */
export const ToolName = z.enum([
  "fetch_route_history",
  "check_traffic_weather",
  "lookup_recipient_history",
]);
export type ToolName = z.infer<typeof ToolName>;

/** What `plan` is allowed to return. At most two tools; zero is a valid plan. */
export const ToolPlan = z.strictObject({
  tools: z.array(ToolName).max(2),
  /** Free text, for the SSE stream only. Never read by the engine. */
  rationale: z.string().optional(),
});
export type ToolPlan = z.infer<typeof ToolPlan>;

/** One scored contradiction. Every flag names the fields it was derived from. */
export type Flag = {
  /** "H1".."H4" for hard checks, "I1".."I14" and "P1".."P5" for scores. */
  code: string;
  /** Plain-language text for the operator. */
  label: string;
  points: number;
  /** Field paths the flag was computed from, e.g. ["eventTime", "recordTime"]. */
  evidence: string[];
};

/** Axis 1: single-event contradiction. Produced by `verify`. */
export type InconsistencyResult = {
  score: number;
  flags: Flag[];
  /** Set when a hard check failed. A hard failure aborts; it is never partial. */
  abortCode?: string;
};

/** Axis 2: per-courier rolling pattern. Produced by `fetch_history`. */
export type PatternResult = {
  score: number;
  flags: Flag[];
  /** How many prior events the window actually contained. Thin history is a caveat. */
  sampleSize: number;
};

/** A frame emitted to the operator console over SSE. */
export type AgentTrace = {
  node: Node;
  phase: "start" | "end" | "thought";
  at: string;
  detail?: unknown;
};

/** Everything the machine accumulates. Nodes read it and write their own slice. */
export type AgentContext = {
  /** Raw input as received, before validation. */
  readonly input: unknown;

  /** parse */
  event?: EpcisEvent;
  parseError?: string;
  /**
   * True when the client sent a recordTime of its own. The server authors that
   * field; a device supplying it is claiming to know when the server received
   * something it has not yet sent, which the engine treats as a signal.
   */
  recordTimeSuppliedByClient?: boolean;

  /** lookup */
  parcel?: { epc: string; known: boolean; recipientAddress?: string; declaredValueSen?: number };
  courier?: { courierId: string; known: boolean; boundDeviceId?: string | null };
  mandate?: { mandateId: string; known: boolean; status?: string };
  /** Set when the parcel or courier is unrecognised. Unknown is high risk, not neutral. */
  unknownEntityRisk?: "high";

  /** plan */
  plan?: ToolPlan;
  /** True when the deterministic heuristic produced the plan (LLM off, failed, or lite mode). */
  planFromHeuristic?: boolean;

  /** verify - axis 1 */
  inconsistency?: InconsistencyResult;
  /** Ledger outcome. An aborted or duplicated event short-circuits the run. */
  ledger?:
    | { status: "recorded"; seq: number }
    | { status: "noop"; seq: number; verdict: Verdict }
    | { status: "aborted"; code: "EVENT_ID_REUSE" };

  /** fetch_history - axis 2 */
  pattern?: PatternResult;

  /** external_context */
  externalContext?: { source: string; summary: string; raw?: unknown };

  /** gate */
  decision?: Decision;
  requiresCosign?: boolean;
  verdict?: Verdict;

  /** explain */
  explanation?: string;

  /** Trace of every node, for the SSE stream and the audit trail. */
  trace: AgentTrace[];
  /** Set when the run ended early. */
  halted?: { at: Node; reason: string };
};

/** A fresh context for one event. */
export function createContext(input: unknown): AgentContext {
  return { input, trace: [] };
}

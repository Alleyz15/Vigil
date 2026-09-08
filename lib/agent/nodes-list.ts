/**
 * The eight nodes, in execution order.
 *
 * In its own module so lib/agent/trace.ts can name them without importing the
 * context (which imports the engines, which would make the SSE contract depend
 * on the verdict path).
 */
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

import { type AgentContext, type AgentTrace, type Node, NODES, createContext } from "./context";
import { NODE_FNS, type NodeDeps } from "./nodes";

/**
 * The agent: a switch over eight nodes and one context object.
 *
 * No LangGraph, no orchestration framework. Eight sequential nodes with one
 * early-exit rule is a for-loop; a graph library would add a dependency and a
 * layer of vocabulary to explain, and remove nothing.
 *
 * The node order encodes the central architectural claim:
 *
 *   verify         -> axis 1, single-event inconsistency (H1-H4, I1-I14)
 *   fetch_history  -> axis 2, per-courier rolling pattern (P1-P5)
 *   gate           -> the ONLY place the two axes meet and a decision is made
 *
 * Verdicts are produced here, deterministically. The LLM appears at `plan`
 * (choosing optional tools from a closed enum) and at `explain` (prose for a
 * human). Delete both and every verdict is byte-identical.
 */

export type RunOptions = {
  /** Called on every trace frame, for the SSE stream. */
  onTrace?: (frame: AgentTrace) => void;
};

/** Run one event through the pipeline. */
export function runAgent(input: unknown, deps: NodeDeps, options: RunOptions = {}): AgentContext {
  const ctx = createContext(input);

  for (const node of NODES) {
    if (ctx.halted) break;

    emit(ctx, options, { node, phase: "start", at: deps.now().toISOString() });

    try {
      NODE_FNS[node](ctx, deps);
    } catch (err) {
      // A node that throws must not leave a half-formed verdict behind. We halt
      // and say which node failed, rather than continuing with partial state —
      // an accept produced from a broken run is worse than no answer at all.
      ctx.halted = { at: node, reason: `NODE_ERROR: ${(err as Error).message}` };
      emit(ctx, options, {
        node,
        phase: "end",
        at: deps.now().toISOString(),
        detail: { error: (err as Error).message },
      });
      break;
    }

    emit(ctx, options, {
      node,
      phase: "end",
      at: deps.now().toISOString(),
      detail: summarize(node, ctx),
    });
  }

  return ctx;
}

function emit(ctx: AgentContext, options: RunOptions, frame: AgentTrace): void {
  ctx.trace.push(frame);
  options.onTrace?.(frame);
}

/** What each node contributed, for the SSE stream and the audit trail. */
function summarize(node: Node, ctx: AgentContext): unknown {
  switch (node) {
    case "parse":
      return ctx.event
        ? { eventID: ctx.event.eventID, type: ctx.event.type }
        : { error: ctx.parseError };
    case "lookup":
      return {
        parcelKnown: ctx.parcel?.known ?? null,
        courierKnown: ctx.courier?.known ?? null,
        mandateKnown: ctx.mandate?.known ?? null,
        unknownEntityRisk: ctx.unknownEntityRisk ?? null,
      };
    case "plan":
      return { tools: ctx.plan?.tools ?? [], fromHeuristic: ctx.planFromHeuristic ?? null };
    case "verify":
      return {
        ledger: ctx.ledger?.status ?? null,
        inconsistencyScore: ctx.inconsistency?.score ?? null,
        flags: ctx.inconsistency?.flags.map((f) => f.id) ?? [],
      };
    case "fetch_history":
      return { patternScore: ctx.pattern?.score ?? null, sampleSize: ctx.pattern?.sampleSize ?? null };
    case "external_context":
      return ctx.externalContext ? { source: ctx.externalContext.source } : { skipped: true };
    case "gate":
      return {
        decision: ctx.decision ?? null,
        requiresCosign: ctx.requiresCosign ?? null,
        ledgerSeq: ctx.ledger?.status === "recorded" ? ctx.ledger.seq : null,
      };
    case "explain":
      return { explained: Boolean(ctx.explanation) };
  }
}

export { NODES, createContext };
export type { AgentContext, AgentTrace, Node, NodeDeps };

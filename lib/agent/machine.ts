import { type AgentContext, type Node, NODES, createContext } from "./context";
import { NODE_FNS, type NodeDeps } from "./nodes";
import { TraceFrame } from "./trace";
import type { Credential } from "@/lib/credential";

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
 * Verdicts are produced deterministically, in lib/gate. The LLM will appear at
 * `plan` (choosing optional tools from a closed enum) and at `explain` (prose
 * for a human). Neither can move a verdict, and a test proves it.
 */

export type RunOptions = {
  /** Called on every trace frame, for the SSE stream. */
  onTrace?: (frame: TraceFrame) => void;
  /**
   * The credential presented with this handoff. Per-run, like the event itself,
   * and a SIDECAR — never inside the EPCIS event. See CLAUDE.md.
   */
  credential?: Credential;
};

/**
 * Run one event through the pipeline.
 *
 * Async because `plan` and `explain` reach a model. The deterministic core is
 * untouched by that: nodes 1, 2, 4, 5 and 7 do not await anything, and the
 * verdict is sealed at node 7 before the only node that writes prose runs.
 */
export async function runAgent(
  input: unknown,
  deps: NodeDeps,
  options: RunOptions = {},
): Promise<AgentContext> {
  const ctx = createContext(input);
  const runDeps: NodeDeps = options.credential ? { ...deps, credential: options.credential } : deps;
  let seq = 0;

  const emit = (frame: TraceFrame) => {
    // Validated on the way out: a malformed frame fails here, not in a browser.
    const parsed = TraceFrame.parse(frame);
    ctx.trace.push(parsed);
    options.onTrace?.(parsed);
  };

  for (const node of NODES) {
    if (ctx.halted) break;

    const startedAt = deps.now();
    emit({ type: "tool_start", seq: seq++, node, at: startedAt.toISOString() });

    try {
      await NODE_FNS[node](ctx, runDeps);
    } catch (err) {
      // A node that throws must not leave a half-formed verdict behind. We halt
      // and say which node failed, rather than continuing with partial state —
      // an accept produced from a broken run is worse than no answer at all.
      const message = (err as Error).message;
      ctx.halted = { at: node, reason: `NODE_ERROR: ${message}` };
      const endedAt = deps.now();
      emit({
        type: "tool_end",
        seq: seq++,
        node,
        at: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        error: message,
      });
      break;
    }

    const endedAt = deps.now();
    emit({
      type: "tool_end",
      seq: seq++,
      node,
      at: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      summary: summarize(node, ctx),
    });
  }

  // Exactly one result frame, always last, whether or not the run completed.
  emit({
    type: "result",
    seq: seq++,
    at: deps.now().toISOString(),
    decision: ctx.decision,
    basis: ctx.verdict?.basis,
    requiresCosign: ctx.requiresCosign,
    // Two separate fields. A client must never add them; see CLAUDE.md.
    inconsistencyScore: ctx.inconsistency?.score,
    patternScore: ctx.pattern?.score,
    flags: [
      ...(ctx.inconsistency?.flags ?? []).map((f) => f.id),
      ...(ctx.pattern?.flags ?? []).map((f) => f.id),
    ],
    halted: ctx.halted,
  });

  return ctx;
}

/**
 * Counts and the rendered line only. The per-rule `notEvaluated` list stays out
 * of the frame: it is unbounded, and the console shows the summary.
 */
function pickCoverage(coverage?: { evaluated: number; total: number; line: string }) {
  if (!coverage) return undefined;
  return { evaluated: coverage.evaluated, total: coverage.total, line: coverage.line };
}

/** What each node contributed, for the SSE stream and the audit trail. */
function summarize(node: Node, ctx: AgentContext) {
  switch (node) {
    case "parse":
      return {
        detail: ctx.event
          ? { eventID: ctx.event.eventID, type: ctx.event.type }
          : { error: ctx.parseError ?? null },
      };

    case "lookup":
      return {
        detail: {
          parcelKnown: ctx.parcel?.known ?? null,
          courierKnown: ctx.courier?.known ?? null,
          mandateKnown: ctx.mandate?.known ?? null,
          unknownEntityRisk: ctx.unknownEntityRisk ?? null,
        },
      };

    case "plan":
      return {
        detail: { tools: ctx.plan?.tools ?? [], fromHeuristic: ctx.planFromHeuristic ?? null },
      };

    case "verify":
      return {
        flags: (ctx.inconsistency?.flags ?? []).map((f) => f.id),
        score: ctx.inconsistency?.score,
        coverage: pickCoverage(ctx.coverage?.inconsistency),
        detail: {
          ledger: ctx.ledger?.status ?? null,
          abortCode: ctx.inconsistency?.abortCode ?? null,
        },
      };

    case "fetch_history":
      return {
        flags: (ctx.pattern?.flags ?? []).map((f) => f.id),
        score: ctx.pattern?.score,
        coverage: pickCoverage(ctx.coverage?.pattern),
        detail: {
          sampleSize: ctx.pattern?.sampleSize ?? null,
          coldStart: ctx.patternColdStart ?? null,
        },
      };

    case "external_context":
      return {
        detail: ctx.externalContext ? { source: ctx.externalContext.source } : { skipped: true },
      };

    case "gate":
      return {
        detail: {
          decision: ctx.decision ?? null,
          matrixCell: ctx.gateResult?.matrixCell ?? null,
          requiresCosign: ctx.requiresCosign ?? null,
          cosignReasons: ctx.gateResult?.cosignReasons ?? [],
          limitFlags: (ctx.gateResult?.limitFlags ?? []).map((f) => f.id),
          ledgerSeq: ctx.ledger?.status === "recorded" ? ctx.ledger.seq : null,
        },
      };

    case "explain":
      return { detail: { explained: Boolean(ctx.explanation) } };
  }
}

export { NODES, createContext };
export type { AgentContext, Node, NodeDeps };
export type { TraceFrame };

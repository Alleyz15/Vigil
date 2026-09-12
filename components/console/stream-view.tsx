"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AxisScores } from "./axis-scores";
import { VerdictBadge, type VerdictKind } from "./verdict-badge";

/**
 * View 2: the eight nodes, executing.
 *
 * NO ENTRANCE ANIMATION ON THE NODE SEQUENCE. The stream already has genuine
 * timing, because the nodes really are running — added animation would make it
 * impossible to tell which delays are computation and which are decoration,
 * and being able to tell is the entire point of showing the reasoning. State
 * changes get a CSS colour transition and nothing else. See CLAUDE.md.
 *
 * Consumes the frozen session-4 trace contract over native EventSource.
 */

const NODES = [
  "parse",
  "lookup",
  "plan",
  "verify",
  "fetch_history",
  "external_context",
  "gate",
  "explain",
] as const;
type NodeName = (typeof NODES)[number];

/** What each node does, and which are still stubs. Shown honestly. */
const NODE_INFO: Record<NodeName, { title: string; blurb: string; stub?: string }> = {
  parse: { title: "parse", blurb: "EPCIS event → the five dimensions" },
  lookup: { title: "lookup", blurb: "parcel, courier, mandate" },
  plan: {
    title: "plan",
    blurb: "0–2 tools from a closed enum",
    stub: "no model configured — the deterministic heuristic ran",
  },
  verify: { title: "verify", blurb: "axis 1 — single-event contradiction" },
  fetch_history: { title: "fetch_history", blurb: "axis 2 — per-courier pattern" },
  external_context: {
    title: "external_context",
    blurb: "historical weather, if the plan asked",
  },
  gate: { title: "gate", blurb: "the two axes meet — the verdict" },
  explain: {
    title: "explain",
    blurb: "the operator's explanation",
    stub: "no model configured — structured fallback",
  },
};

type NodeState = {
  status: "pending" | "running" | "done" | "error";
  durationMs?: number;
  flags?: string[];
  score?: number;
  coverage?: string;
  detail?: Record<string, unknown>;
  error?: string;
};

type ResultState = {
  decision?: string;
  basis?: string;
  requiresCosign?: boolean;
  inconsistencyScore?: number;
  patternScore?: number;
  flags: string[];
  halted?: { at: string; reason: string };
};

const blank = (): Record<NodeName, NodeState> =>
  Object.fromEntries(NODES.map((n) => [n, { status: "pending" }])) as Record<NodeName, NodeState>;

export function StreamView({
  scenarioId,
  legCount,
  defaultLeg,
}: {
  scenarioId: string;
  legCount: number;
  defaultLeg: number;
}) {
  const [nodes, setNodes] = useState(blank);
  const [thoughts, setThoughts] = useState<{ node: string; text: string }[]>([]);
  const [result, setResult] = useState<ResultState | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [leg, setLeg] = useState(defaultLeg);
  const sourceRef = useRef<EventSource | null>(null);

  const stop = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setRunning(false);
    setPreparing(null);
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(() => {
    stop();
    setNodes(blank());
    setThoughts([]);
    setResult(null);
    setRunning(true);

    const source = new EventSource(`/api/stream?scenario=${scenarioId}&leg=${leg}`);
    sourceRef.current = source;

    // The preparation is real work: prior legs have to be sealed before the
    // pattern axis has anything to read. Saying what it is doing keeps a viewer
    // from reading a real pipeline as a slow app.
    source.addEventListener("preparing", (e) => {
      setPreparing(JSON.parse((e as MessageEvent).data).message);
    });

    source.addEventListener("tool_start", (e) => {
      const frame = JSON.parse((e as MessageEvent).data);
      setPreparing(null);
      setNodes((prev) => ({ ...prev, [frame.node as NodeName]: { status: "running" } }));
    });

    source.addEventListener("tool_end", (e) => {
      const frame = JSON.parse((e as MessageEvent).data);
      setNodes((prev) => ({
        ...prev,
        [frame.node as NodeName]: {
          status: frame.error ? "error" : "done",
          durationMs: frame.durationMs,
          flags: frame.summary?.flags,
          score: frame.summary?.score,
          coverage: frame.summary?.coverage?.line,
          detail: frame.summary?.detail,
          error: frame.error,
        },
      }));
    });

    source.addEventListener("thought", (e) => {
      const frame = JSON.parse((e as MessageEvent).data);
      setThoughts((prev) => [...prev, { node: frame.node, text: frame.text }]);
    });

    source.addEventListener("result", (e) => {
      setResult(JSON.parse((e as MessageEvent).data));
    });

    source.addEventListener("complete", () => stop());
    source.addEventListener("error", () => stop());
  }, [scenarioId, leg, stop]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
          <Button size="sm" onClick={running ? stop : start} className="w-24">
            {running ? "Stop" : "Run"}
          </Button>

          <label className="ml-2 flex items-center gap-2 text-xs text-muted-foreground">
            leg
            <input
              type="number"
              min={1}
              max={legCount}
              value={leg + 1}
              onChange={(e) => setLeg(Math.max(0, Math.min(legCount - 1, Number(e.target.value) - 1)))}
              className="w-16 rounded border border-border/60 bg-background px-2 py-1 font-mono text-xs tabular-nums"
            />
            <span className="font-mono">of {legCount}</span>
          </label>

          {preparing && <span className="ml-auto text-sm text-sky-300">{preparing}…</span>}
        </div>

        <ol className="mt-4 space-y-2">
          {NODES.map((name, i) => (
            <NodeRow key={name} index={i} name={name} state={nodes[name]} />
          ))}
        </ol>
      </div>

      <aside className="space-y-4">
        <ResultPanel result={result} />

        <div className="rounded-lg border border-border/60 bg-card/40 p-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Thoughts ({thoughts.length})
          </div>
          {thoughts.length === 0 ? (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              The only frame a model ever authors. None yet — no model is configured, so the
              deterministic paths ran instead.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {thoughts.map((t, i) => (
                <li key={i} className="text-sm leading-relaxed">
                  <span className="font-mono text-xs text-muted-foreground">{t.node}</span>
                  <div>{t.text}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function NodeRow({ index, name, state }: { index: number; name: NodeName; state: NodeState }) {
  const info = NODE_INFO[name];
  const isStub = Boolean(info.stub) && state.status === "done";

  return (
    <li
      className={cn(
        // Colour transition only. No entrance animation: the timing a viewer
        // sees has to be the nodes actually running.
        "rounded-lg border px-4 py-3 transition-colors duration-200",
        state.status === "pending" && "border-border/40 bg-card/20 opacity-50",
        state.status === "running" && "border-sky-500/50 bg-sky-500/[0.07]",
        state.status === "done" && "border-border/60 bg-card/50",
        state.status === "error" && "border-rose-500/50 bg-rose-500/[0.07]",
      )}
    >
      <div className="flex items-center gap-3">
        <span className="w-5 font-mono text-xs tabular-nums text-muted-foreground">
          {index + 1}
        </span>
        <span className="font-mono text-sm">{info.title}</span>
        <span className="text-sm text-muted-foreground">{info.blurb}</span>

        <span className="ml-auto flex items-center gap-3">
          {state.score !== undefined && (
            <span className="font-mono text-xs tabular-nums text-amber-300">{state.score}</span>
          )}
          {state.durationMs !== undefined && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {state.durationMs}ms
            </span>
          )}
          <StatusDot status={state.status} />
        </span>
      </div>

      {(state.flags?.length ?? 0) > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 pl-8">
          {state.flags!.map((flag) => (
            <span
              key={flag}
              className="rounded bg-amber-500/15 px-2 py-0.5 font-mono text-xs text-amber-300"
            >
              {flag}
            </span>
          ))}
        </div>
      )}

      {state.coverage && (
        <div className="mt-2 pl-8 text-xs text-muted-foreground">{state.coverage}</div>
      )}

      {name === "external_context" && state.status === "done" && state.detail && (
        <div className="mt-2 pl-8 text-xs leading-relaxed text-sky-200">
          {String(state.detail.summary ?? "Weather lookup was not selected.")}
        </div>
      )}

      {/* Shown honestly as a stub where it is one. */}
      {isStub && <div className="mt-2 pl-8 text-xs text-zinc-400 italic">{info.stub}</div>}

      {state.error && <div className="mt-2 pl-8 text-xs text-rose-300">{state.error}</div>}
    </li>
  );
}

function StatusDot({ status }: { status: NodeState["status"] }) {
  return (
    <span
      className={cn(
        "size-2 rounded-full transition-colors duration-200",
        status === "pending" && "bg-zinc-600",
        status === "running" && "bg-sky-400",
        status === "done" && "bg-emerald-400",
        status === "error" && "bg-rose-400",
      )}
    />
  );
}

function ResultPanel({ result }: { result: ResultState | null }) {
  if (!result) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
        The result frame arrives last, whether or not the run completed.
      </div>
    );
  }

  // A halt is information, not an error: it says where the run stopped and why.
  const halted = Boolean(result.halted);
  const kind: VerdictKind = halted
    ? result.halted!.reason === "PENDING_COSIGNATURE" ||
      result.halted!.reason === "PENDING_COURIER_SIGNATURE"
      ? "pending"
      : "halted"
    : ((result.decision ?? "halted") as VerdictKind);

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">Result</div>

      <div className="mt-2">
        <VerdictBadge kind={kind} />
      </div>

      {halted && (
        <div className="mt-3 rounded-md border border-sky-500/30 bg-sky-500/[0.06] px-3 py-2 text-sm leading-relaxed">
          <div className="font-medium text-sky-300">
            Stopped at <span className="font-mono">{result.halted!.at}</span>
          </div>
          <div className="mt-1 text-muted-foreground">
            {result.halted!.reason === "PENDING_COSIGNATURE"
              ? "Nothing was sealed. This handoff needs an operator co-signature and none was presented, so there is no valid credential to record."
              : result.halted!.reason === "PENDING_COURIER_SIGNATURE"
                ? "Nothing was sealed. Every handoff needs the courier's signature, and none was presented."
                : result.halted!.reason}
          </div>
        </div>
      )}

      <AxisScores
        className="mt-4"
        inconsistencyScore={result.inconsistencyScore ?? null}
        patternScore={result.patternScore ?? null}
        inconsistencyEvaluable={result.inconsistencyScore !== undefined}
        patternEvaluable={result.patternScore !== undefined}
      />

      <dl className="mt-4 space-y-1 text-sm">
        <Row label="basis" value={result.basis ?? "—"} />
        <Row label="co-signature" value={result.requiresCosign ? "required" : "not required"} />
        <Row label="flags" value={result.flags.length > 0 ? result.flags.join(", ") : "none"} />
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono text-xs">{value}</dd>
    </div>
  );
}

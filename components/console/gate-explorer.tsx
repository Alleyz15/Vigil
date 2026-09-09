"use client";

import { useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { ScatterPoint } from "@/lib/console/dataset";

/**
 * View 3: the two axes, and the four actions they produce.
 *
 * NO ANIMATION ON THE RECOLOUR PATH. The value of this view is "I drag, it
 * changes NOW" — any easing reads as lag and undermines the point. ECharts'
 * own transitions are disabled rather than shortened. See CLAUDE.md.
 *
 * Points where an axis could not be evaluated are plotted in gutter bands
 * OUTSIDE the numeric scale, never at the origin. Plotting them at zero would
 * assert a measurement that was never made.
 */

const GUTTER = -14;
const AXIS_MAX = 105;

const QUADRANT_COLOUR: Record<string, string> = {
  accept: "#34d399",
  flag: "#fbbf24",
  escalate: "#fb923c",
  freeze: "#fb7185",
};

function quadrant(x: number, y: number, xLimit: number, yLimit: number): string {
  const high = x >= xLimit;
  const highPattern = y >= yLimit;
  if (high && highPattern) return "freeze";
  if (high) return "flag";
  if (highPattern) return "escalate";
  return "accept";
}

/**
 * Three reference points, labelled as reference points.
 *
 * ILLUSTRATIVE, NOT OBSERVED. No real event in the dataset sits at (80, 0) or
 * (40, 40) — S1 scores 100 and the middle case does not occur — so these are
 * drawn in their own series with their own styling. Mixing three invented
 * points into an observation series would claim data we do not have.
 */
const TRIO = [
  {
    value: [0, 80],
    name: "ESCALATE",
    note: "investigate the courier",
    label: { position: "right", offset: [8, 0] },
  },
  {
    value: [80, 0],
    name: "FLAG",
    note: "re-check the event",
    label: { position: "top", offset: [0, -5] },
  },
  {
    value: [40, 40],
    name: "FREEZE",
    note: "stop the scope",
    label: { position: "right", offset: [8, 0] },
  },
];

export function GateExplorer({
  points,
  counts,
}: {
  points: ScatterPoint[];
  counts: { total: number; bothEvaluated: number; patternUnknown: number; inconsistencyUnknown: number };
}) {
  const [xThreshold, setXThreshold] = useState(30);
  const [yThreshold, setYThreshold] = useState(40);
  const [hovered, setHovered] = useState<ScatterPoint | null>(null);

  const series = useMemo(() => {
    const both: [number, number, ScatterPoint][] = [];
    const patternUnknown: [number, number, ScatterPoint][] = [];
    const inconsistencyUnknown: [number, number, ScatterPoint][] = [];
    const neither: [number, number, ScatterPoint][] = [];

    for (const p of points) {
      const x = p.inconsistencyScore;
      const y = p.patternScore;
      if (x !== null && y !== null) both.push([x, y, p]);
      else if (x !== null) patternUnknown.push([x, GUTTER, p]);
      else if (y !== null) inconsistencyUnknown.push([GUTTER, y, p]);
      else neither.push([GUTTER, GUTTER, p]);
    }

    return { both, patternUnknown, inconsistencyUnknown, neither };
  }, [points]);

  const option = useMemo(
    () => ({
      // Instant. Any easing on the recolour reads as lag.
      animation: false,
      backgroundColor: "transparent",
      grid: { left: 72, right: 250, top: 42, bottom: 64 },
      xAxis: {
        min: GUTTER - 6,
        max: AXIS_MAX,
        name: "single-event inconsistency",
        nameLocation: "middle",
        nameGap: 30,
        nameTextStyle: { color: "#d4d4d8", fontSize: 13, fontWeight: 600 },
        axisLine: { lineStyle: { color: "#3f3f46" } },
        axisLabel: {
          color: "#71717a",
          fontSize: 11,
          formatter: (v: number) => (v < 0 ? "n/e" : String(v)),
        },
        splitLine: { lineStyle: { color: "#27272a" } },
      },
      yAxis: {
        min: GUTTER - 6,
        max: AXIS_MAX,
        name: "pattern",
        nameTextStyle: { color: "#d4d4d8", fontSize: 13, fontWeight: 600 },
        axisLine: { lineStyle: { color: "#3f3f46" } },
        axisLabel: {
          color: "#71717a",
          fontSize: 11,
          formatter: (v: number) => (v < 0 ? "n/e" : String(v)),
        },
        splitLine: { lineStyle: { color: "#27272a" } },
      },
      tooltip: {
        trigger: "item",
        backgroundColor: "#18181b",
        borderColor: "#3f3f46",
        textStyle: { color: "#e4e4e7", fontSize: 13 },
        formatter: (params: { data: [number, number, ScatterPoint | undefined]; seriesName: string }) => {
          const p = params.data?.[2];
          if (!p) return params.seriesName;
          const lines = [
            `<b>${p.scenarioId}</b> leg ${p.legIndex + 1}`,
            `decision: ${p.decision ?? "—"}`,
            p.inconsistencyScore === null
              ? // Saying WHY is materially stronger than saying "unknown".
                `single-event: not evaluated — ${p.inconsistencyUnknownReason}`
              : `single-event: ${p.inconsistencyScore}`,
            p.patternScore === null
              ? `pattern: not evaluated — ${p.patternUnknownReason}`
              : `pattern: ${p.patternScore}`,
          ];
          return lines.join("<br/>");
        },
      },
      series: [
        // The gutter bands: outside the scale, hollow, distinct.
        {
          name: "pattern not evaluated",
          type: "scatter",
          symbolSize: 9,
          data: series.patternUnknown,
          itemStyle: { color: "transparent", borderColor: "#a1a1aa", borderWidth: 1.2 },
        },
        {
          name: "single-event not evaluated",
          type: "scatter",
          symbolSize: 9,
          data: series.inconsistencyUnknown,
          itemStyle: { color: "transparent", borderColor: "#a1a1aa", borderWidth: 1.2 },
        },
        {
          name: "neither evaluated",
          type: "scatter",
          symbolSize: 9,
          data: series.neither,
          itemStyle: { color: "transparent", borderColor: "#71717a", borderWidth: 1.2 },
        },
        {
          name: "observations",
          type: "scatter",
          symbolSize: 11,
          data: series.both,
          itemStyle: {
            color: (params: { data: [number, number, ScatterPoint] }) =>
              QUADRANT_COLOUR[quadrant(params.data[0], params.data[1], xThreshold, yThreshold)],
            opacity: 0.85,
          },
          markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            lineStyle: { color: "#e4e4e7", type: "dashed", width: 1 },
            label: { color: "#a1a1aa", fontSize: 10 },
            data: [
              { xAxis: xThreshold, label: { formatter: `x ${xThreshold}` } },
              { yAxis: yThreshold, label: { formatter: `y ${yThreshold}` } },
            ],
          },
          markArea: {
            silent: true,
            animation: false,
            itemStyle: { opacity: 0.05 },
            data: [
              [
                { xAxis: GUTTER - 6, yAxis: GUTTER - 6, itemStyle: { color: "#a1a1aa" } },
                { xAxis: AXIS_MAX, yAxis: 0 },
              ],
              [
                { xAxis: GUTTER - 6, yAxis: GUTTER - 6, itemStyle: { color: "#a1a1aa" } },
                { xAxis: 0, yAxis: AXIS_MAX },
              ],
            ],
          },
        },
        // The illustrative trio, in its own series and visibly not an observation.
        {
          name: "reference points (illustrative)",
          type: "scatter",
          symbolSize: 24,
          symbol: "diamond",
          data: TRIO.map((t) => ({ ...t, value: t.value })),
          itemStyle: { color: "#18181b", borderColor: "#fafafa", borderWidth: 2.4 },
          label: {
            show: true,
            distance: 12,
            color: "#fafafa",
            fontSize: 13,
            fontWeight: 600,
            lineHeight: 18,
            backgroundColor: "rgba(9, 9, 11, 0.92)",
            borderColor: "#52525b",
            borderWidth: 1,
            borderRadius: 3,
            padding: [5, 7],
            formatter: (p: { data: { value: number[]; name: string; note: string } }) =>
              `${p.data.name}  (${p.data.value[0]}, ${p.data.value[1]})\nSame sum · ${p.data.note}`,
          },
          tooltip: {
            formatter: "Reference point, not an observation.",
          },
        },
      ],
    }),
    [series, xThreshold, yThreshold],
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="rounded-lg border border-border/60 bg-card/40 p-2">
        <ReactECharts
          option={option}
          style={{ height: 620 }}
          notMerge
          lazyUpdate={false}
          opts={{ renderer: "canvas" }}
          onEvents={{
            mouseover: (e: { data?: [number, number, ScatterPoint] }) => setHovered(e.data?.[2] ?? null),
            mouseout: () => setHovered(null),
          }}
        />
      </div>

      <aside className="space-y-4">
        <div className="rounded-lg border border-border/60 bg-card/40 p-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Thresholds
          </div>

          <ThresholdSlider
            label="single-event (x)"
            value={xThreshold}
            onChange={setXThreshold}
            hint="above this, the event contradicts itself"
          />
          <ThresholdSlider
            label="pattern (y)"
            value={yThreshold}
            onChange={setYThreshold}
            hint="above this, the courier's shape is wrong"
          />

          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            {(["accept", "flag", "escalate", "freeze"] as const).map((q) => (
              <div key={q} className="flex items-center gap-1.5">
                <span
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: QUADRANT_COLOUR[q] }}
                />
                <span className="text-muted-foreground">{q}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border/60 bg-card/40 p-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            {hovered ? "Hovered" : "Dataset"}
          </div>

          {hovered ? (
            <div className="mt-2 space-y-1.5 text-[13px]">
              <div className="font-mono">
                {hovered.scenarioId} · leg {hovered.legIndex + 1}
              </div>
              <Unknown
                label="single-event"
                score={hovered.inconsistencyScore}
                reason={hovered.inconsistencyUnknownReason}
              />
              <Unknown
                label="pattern"
                score={hovered.patternScore}
                reason={hovered.patternUnknownReason}
              />
            </div>
          ) : (
            <dl className="mt-2 space-y-1.5 text-[13px]">
              <Stat label="events" value={counts.total} />
              <Stat label="both axes evaluated" value={counts.bothEvaluated} />
              <Stat label="pattern not evaluated" value={counts.patternUnknown} />
              <Stat label="single-event not evaluated" value={counts.inconsistencyUnknown} />
            </dl>
          )}
        </div>

        <div className="rounded-lg border border-border/60 bg-card/40 p-4 text-[13px] leading-relaxed text-muted-foreground">
          <p>
            Points in the shaded bands could not be evaluated on that axis. They are drawn outside
            the scale rather than at zero — plotting them at the origin would claim a measurement
            nobody made. Hover one to see why.
          </p>
          <p className="mt-2">
            The three outlined diamonds are reference points, not observations. Their axis scores
            sum to 80 in every case, and they need three different actions.
          </p>
        </div>
      </aside>
    </div>
  );
}

function ThresholdSlider({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint: string;
}) {
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px]">{label}</span>
        <span className="font-mono text-[13px] tabular-nums">{value}</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-sky-400"
      />
      <div className="text-xs leading-tight text-muted-foreground">{hint}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}

function Unknown({
  label,
  score,
  reason,
}: {
  label: string;
  score: number | null;
  reason: string | null;
}) {
  if (score !== null) {
    return (
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">{score}</span>
      </div>
    );
  }
  return (
    <div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">{label}</span>
        <span className="italic text-muted-foreground">not evaluated</span>
      </div>
      <div className="mt-0.5 text-xs leading-snug text-zinc-400">{reason}</div>
    </div>
  );
}

"use client";

import NumberFlow from "@number-flow/react";
import { CircleDashed, Gauge } from "lucide-react";
import type { AxisValue } from "@/lib/workbench";
import { cn } from "@/lib/utils";

/**
 * The two axes, in two sizes.
 *
 * `compact` is for queue rows, where the score is one column among many.
 * `feature` is for the one place a viewer is being asked to understand the
 * architecture rather than scan a list — and there the numbers get room, the
 * cards get separated, and the heading states the claim outright.
 *
 * WHY THE HEADING IS PART OF THE COMPONENT. "Two axes, never summed" is the
 * load-bearing design decision of the whole project (rule 2), and a viewer who
 * sees two small adjacent numbers will read them as components of a total.
 * Separating the cards and naming the rule is what stops that reading. It lives
 * here so every feature-sized rendering carries it, rather than depending on
 * each page to remember.
 */

function Axis({ label, value, variant }: { label: string; value: AxisValue; variant: Variant }) {
  // Bound as a value rather than a boolean: a `const ok = ...` flag does not
  // narrow `value.score` for the compiler, and the score is genuinely nullable
  // because an axis that could not be evaluated has no number (rule 4).
  const score = value.evaluable ? value.score : null;

  if (variant === "compact") {
    return <AxisBar label={label} value={value} />;
  }

  return (
    <div className="rounded-md bg-muted/60 px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      {score !== null ? (
        <div className="mt-0.5 text-2xl font-semibold tabular-nums">
          {/*
            Counts only in the feature size. In a queue row the number is being
            scanned against dozens of others and motion there is noise; here a
            viewer is being asked to look at one number.
          */}
          <NumberFlow value={score} />
        </div>
      ) : (
        <>
          {/*
            Never a zero. A null score means the axis could not be evaluated,
            and drawing it as 0 claims a measurement nobody made (rule 3e).
          */}
          <div className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <CircleDashed aria-hidden="true" className="size-3.5" />
            not evaluated
          </div>
          {value.reason && (
            <p className="mt-1 text-xs leading-4 text-muted-foreground">{value.reason}</p>
          )}
        </>
      )}
    </div>
  );
}

type Variant = "compact" | "feature";

/**
 * One axis in a queue row: a thin bar in ITS OWN frame, with the number beside it.
 *
 * THE SHAPE HAS TO CARRY THE ANSWER. Two numerals side by side read like a
 * timestamp; a reviewer scanning thirty rows should see "tall on the left" or
 * "tall on the right" before reading anything. Position carries which axis —
 * single-event always left, pattern always right — and height carries how high.
 *
 * WHAT THE BARS MUST NOT SAY. Each bar sits in its own framed track, and that
 * frame is its own 0–100 scale. No shared axis line, no stacking, no bar growing
 * from a common centre: any of those makes two independent axes look like parts
 * of one quantity, which is the reading rule 2 exists to prevent. The code is
 * guarded against summing them; the picture must not imply it either.
 *
 * NOT EVALUATED IS NOT ZERO. A score of 0 is a solid frame with nothing in it; an
 * axis that could not be evaluated is a DASHED frame with nothing in it — a
 * visibly different object, as the gate explorer's gutter bands are (rule 3e).
 */
function AxisBar({ label, value }: { label: string; value: AxisValue }) {
  const score = value.evaluable ? value.score : null;
  const name = label === "Pattern" ? "Pattern" : "Single";
  const spoken =
    score === null ? `${label}: not evaluated${value.reason ? ` (${value.reason})` : ""}` : `${label}: ${score} of 100`;

  return (
    <div className="flex items-end gap-2" aria-label={spoken} title={spoken} role="img">
      <span className="w-12 text-xs font-medium text-muted-foreground">{name}</span>
      <span
        aria-hidden="true"
        data-axis-track={score === null ? "not-evaluated" : "evaluated"}
        className={cn(
          "relative block h-6 w-1.5 shrink-0 overflow-hidden rounded-sm border",
          score === null ? "border-dashed border-foreground/50" : "border-foreground/25",
        )}
      >
        {score !== null && (
          <span
            className="absolute inset-x-0 bottom-0 bg-foreground"
            style={{ height: `${Math.min(100, Math.max(0, score))}%` }}
          />
        )}
      </span>
      <span className="w-8 font-mono text-sm font-semibold tabular-nums">{score === null ? "n/e" : score}</span>
    </div>
  );
}

export function AxisPair({
  inconsistency,
  pattern,
  variant = "compact",
  coverageLine,
}: {
  inconsistency: AxisValue;
  pattern: AxisValue;
  variant?: Variant;
  /**
   * "12 of 16 checks evaluable" — the visible output of the three-state rule.
   * Passed in rather than derived here, because the engine computed it.
   */
  coverageLine?: string | null;
}) {
  if (variant === "compact") {
    return (
      // Two framed tracks with a gap between them; see AxisBar for why they
      // never share a baseline.
      <div className="flex gap-4">
        <Axis label="Single-event" value={inconsistency} variant="compact" />
        <Axis label="Pattern" value={pattern} variant="compact" />
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Two axes, never summed
      </h2>

      <div className="mt-2 grid grid-cols-2 gap-3">
        <Axis label="Single-event" value={inconsistency} variant="feature" />
        <Axis label="Pattern" value={pattern} variant="feature" />
      </div>

      {/*
        COVERAGE IS NOT A FOOTNOTE. A score of 0 from 12 evaluated checks and a
        score of 0 from 2 are different claims, and an operator who cannot tell
        them apart is being misled by their own dashboard (rule 4). It was 11px
        grey; it now reads at the same size as the rest of the panel.
      */}
      <div className="mt-2.5 flex items-center gap-1.5 text-sm">
        <Gauge aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{coverageLine ?? "Evidence coverage unavailable"}</span>
      </div>
    </div>
  );
}

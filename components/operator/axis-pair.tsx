import { CircleDashed, Gauge } from "lucide-react";
import type { AxisValue } from "@/lib/workbench";

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
  const evaluated = value.evaluable && value.score !== null;

  if (variant === "compact") {
    return (
      <div className="min-w-20">
        <div className="text-xs font-semibold uppercase text-muted-foreground">{label}</div>
        {evaluated ? (
          <div className="mt-0.5 font-mono text-base font-semibold tabular-nums">{value.score}</div>
        ) : (
          <div
            className="mt-0.5 text-xs font-medium text-muted-foreground"
            title={value.reason ?? undefined}
          >
            Not evaluated
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md bg-muted/60 px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      {evaluated ? (
        <div className="mt-0.5 text-2xl font-semibold tabular-nums">{value.score}</div>
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

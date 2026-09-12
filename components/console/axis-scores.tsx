import { cn } from "@/lib/utils";

/**
 * The two axis scores, side by side, never added.
 *
 * A single component so the prohibition is enforced in one place rather than
 * re-argued at every call site. There is no prop that renders a total, and
 * adding one would be the UI committing the error the whole architecture is
 * built to avoid. See CLAUDE.md.
 */

type AxisScoreProps = {
  label: string;
  score: number | null;
  /** Absent evidence is not a zero. */
  evaluable: boolean;
  reason?: string | null;
  high?: boolean;
};

function AxisScore({ label, score, evaluable, reason, high }: AxisScoreProps) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      {evaluable && score !== null ? (
        <div
          className={cn(
            "font-mono text-lg leading-tight tabular-nums",
            high ? "text-amber-400" : "text-foreground",
          )}
        >
          {score}
        </div>
      ) : (
        <div
          className="font-mono text-sm leading-tight text-muted-foreground italic"
          title={reason ?? undefined}
        >
          not evaluated
        </div>
      )}
    </div>
  );
}

export function AxisScores({
  inconsistencyScore,
  patternScore,
  inconsistencyEvaluable,
  patternEvaluable,
  inconsistencyReason,
  patternReason,
  className,
}: {
  inconsistencyScore: number | null;
  patternScore: number | null;
  inconsistencyEvaluable: boolean;
  patternEvaluable: boolean;
  inconsistencyReason?: string | null;
  patternReason?: string | null;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-6", className)}>
      <AxisScore
        label="single-event"
        score={inconsistencyScore}
        evaluable={inconsistencyEvaluable}
        reason={inconsistencyReason}
        high={(inconsistencyScore ?? 0) >= 30}
      />
      <AxisScore
        label="pattern"
        score={patternScore}
        evaluable={patternEvaluable}
        reason={patternReason}
        high={(patternScore ?? 0) >= 40}
      />
    </div>
  );
}

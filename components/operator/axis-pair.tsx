import type { AxisValue } from "@/lib/workbench";

function Axis({ label, value }: { label: string; value: AxisValue }) {
  return (
    <div className="min-w-20">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      {value.evaluable && value.score !== null ? (
        <div className="mt-0.5 font-mono text-base font-semibold tabular-nums">{value.score}</div>
      ) : (
        <div className="mt-0.5 text-xs font-medium text-muted-foreground" title={value.reason ?? undefined}>
          Not evaluated
        </div>
      )}
    </div>
  );
}

export function AxisPair({ inconsistency, pattern }: { inconsistency: AxisValue; pattern: AxisValue }) {
  return (
    <div className="flex gap-5">
      <Axis label="Single-event" value={inconsistency} />
      <Axis label="Pattern" value={pattern} />
    </div>
  );
}

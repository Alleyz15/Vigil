import { loadScatter } from "@/lib/console/dataset";
import { GateExplorer } from "@/components/console/gate-explorer";

export const dynamic = "force-dynamic";

export default async function GatePage() {
  const points = await loadScatter();

  const counts = {
    total: points.length,
    bothEvaluated: points.filter((p) => p.inconsistencyScore !== null && p.patternScore !== null).length,
    patternUnknown: points.filter((p) => p.patternScore === null).length,
    inconsistencyUnknown: points.filter((p) => p.inconsistencyScore === null).length,
  };

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-lg font-semibold tracking-tight">Gate explorer</h1>
        <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">
          Every event across all seven scenarios, on two independent axes. Drag either threshold
          and watch the same events redistribute across four different actions. The axes are never
          added together — a courier at (0, 80) and one at (80, 0) have the same total and need
          opposite responses.
        </p>
      </header>

      <GateExplorer points={points} counts={counts} />
    </div>
  );
}

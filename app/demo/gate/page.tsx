import { GateExplorer } from "@/components/console/gate-explorer";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import { loadScatter } from "@/lib/console/dataset";

export const dynamic = "force-dynamic";

export default async function DemoGatePage() {
  const points = await loadScatter();
  const counts = {
    total: points.length,
    bothEvaluated: points.filter((point) => point.inconsistencyScore !== null && point.patternScore !== null).length,
    patternUnknown: points.filter((point) => point.patternScore === null).length,
    inconsistencyUnknown: points.filter((point) => point.inconsistencyScore === null).length,
  };

  return (
    <div>
      <header className="mb-5 flex items-start justify-between gap-8">
        <div>
          <h1 className="text-2xl font-semibold">Orthogonal gate evidence</h1>
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">
            This is a demo instrument, not the operator&apos;s work queue. It shows why identical totals can require different actions when the two axes remain separate.
          </p>
        </div>
        <ProvenanceLabel>illustrative reference points separated from observations</ProvenanceLabel>
      </header>
      <GateExplorer points={points} counts={counts} />
    </div>
  );
}

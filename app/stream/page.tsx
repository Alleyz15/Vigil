import { Suspense } from "react";
import { SCENARIO_IDS, type ScenarioId, loadAllScenarios, loadScenario } from "@/lib/console/dataset";
import { ScenarioPicker } from "@/components/console/scenario-picker";
import { StreamView } from "@/components/console/stream-view";

export const dynamic = "force-dynamic";

export default async function StreamPage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string; leg?: string }>;
}) {
  const params = await searchParams;
  const requested = params.scenario as ScenarioId | undefined;
  const id: ScenarioId = requested && SCENARIO_IDS.includes(requested) ? requested : "S1";

  const [{ view }, all] = await Promise.all([loadScenario(id), loadAllScenarios()]);
  const requestedLeg = Number(params.leg);
  const defaultLeg = Number.isFinite(requestedLeg)
    ? Math.max(0, Math.min(view.legCount - 1, requestedLeg))
    : view.legCount - 1;

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-lg font-semibold tracking-tight">Reasoning stream</h1>
        <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">
          One event through the eight agent nodes, streamed over SSE as they execute. The delays
          between nodes are the nodes running — nothing here is replayed from a recording, and no
          entrance animation is added, so the timing you see is the timing that happened.
        </p>

        <div className="mt-4">
          <Suspense fallback={null}>
            <ScenarioPicker
              basePath="/stream"
              value={view.id}
              scenarios={all.map((s) => ({
                id: s.id,
                title: s.title,
                expectedDecision: s.expectedDecision,
              }))}
            />
          </Suspense>
        </div>
      </header>

      <StreamView scenarioId={view.id} legCount={view.legCount} defaultLeg={defaultLeg} />
    </div>
  );
}

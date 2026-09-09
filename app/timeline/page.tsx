import { Suspense } from "react";
import { SCENARIO_IDS, type ScenarioId, loadAllScenarios, loadScenario } from "@/lib/console/dataset";
import { ScenarioPicker } from "@/components/console/scenario-picker";
import { TimelineView } from "@/components/console/timeline-view";

export const dynamic = "force-dynamic";

export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string; frame?: string }>;
}) {
  const params = await searchParams;
  const requested = params.scenario as ScenarioId | undefined;
  const id: ScenarioId = requested && SCENARIO_IDS.includes(requested) ? requested : "S0";

  const [{ view }, all] = await Promise.all([loadScenario(id), loadAllScenarios()]);

  return (
    <div>
      <header className="mb-5">
        <div className="flex items-start justify-between gap-8">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">
              <span className="font-mono text-muted-foreground">{view.id}</span>{" "}
              <span className="ml-1">{view.title}</span>
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              {view.description}
            </p>
          </div>

          <div className="shrink-0 text-right">
            <div className="font-mono text-[11px] text-muted-foreground">
              courier {view.courierId}
            </div>
            <div className="mt-1 font-mono text-[11px] text-muted-foreground">
              ledger {view.ledger.entries} entries ·{" "}
              <span className={view.ledger.chainValid ? "text-emerald-400" : "text-rose-400"}>
                chain {view.ledger.chainValid ? "valid" : "BROKEN"}
              </span>
              {view.ledger.aborts > 0 && (
                <span className="text-rose-300"> · {view.ledger.aborts} abort</span>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4">
          <Suspense fallback={null}>
            <ScenarioPicker
              basePath="/timeline"
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

      {/* Keyed on the scenario so a switch remounts and playback restarts,
          rather than an effect reaching in to reset state. */}
      <TimelineView
        key={`${view.id}-${params.frame ?? "playback"}`}
        scenario={view}
        initialLeg={
          params.frame === "exception" && view.exceptionLegIndex !== null
            ? view.exceptionLegIndex
            : undefined
        }
      />
    </div>
  );
}

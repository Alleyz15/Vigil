import { HandoffTable } from "@/components/operator/handoff-table";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function HandoffsPage({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  const { scenario } = await searchParams;
  const workbench = await getWorkbench();
  const result = workbench.listHandoffs();
  const items = scenario ? result.items.filter((item) => item.scenarioId === scenario) : result.items;
  const accepted = items.filter((item) => item.state === "accepted").length;
  const summary = scenario
    ? { ...result.summary, automaticallyAccepted: accepted, total: items.length }
    : result.summary;

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">All handoffs</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Accepted work stays visible with its deterministic gate basis. Exceptions remain evidence, not the whole picture.
        </p>
      </header>
      <HandoffTable items={items} summary={summary} />
    </div>
  );
}

import { HandoffsWorkspace } from "@/components/operator/handoffs-workspace";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function HandoffsPage({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  const { scenario } = await searchParams;
  const workbench = await getWorkbench();
  const queue = workbench.listQueue();
  const result = workbench.listHandoffs();
  const allItems = scenario ? result.items.filter((item) => item.scenarioId === scenario) : result.items;
  const queueItems = scenario ? queue.filter((item) => item.scenarioId === scenario) : queue;
  const accepted = allItems.filter((item) => item.decision === "accept" && item.sealed).length;
  const summary = scenario
    ? { ...result.summary, automaticallyAccepted: accepted, total: allItems.length }
    : result.summary;

  return (
    <HandoffsWorkspace
      mode="all"
      queueItems={queueItems}
      allItems={allItems}
      summary={summary}
      scenario={scenario}
    />
  );
}

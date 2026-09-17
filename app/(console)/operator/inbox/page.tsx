import { HandoffsWorkspace } from "@/components/operator/handoffs-workspace";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  const { scenario } = await searchParams;
  const workbench = await getWorkbench();
  const queue = workbench.listQueue();
  const handoffs = workbench.listHandoffs();
  const queueItems = scenario ? queue.filter((item) => item.scenarioId === scenario) : queue;
  const allItems = scenario ? handoffs.items.filter((item) => item.scenarioId === scenario) : handoffs.items;
  const accepted = allItems.filter((item) => item.decision === "accept" && item.sealed).length;
  const summary = scenario
    ? { ...handoffs.summary, automaticallyAccepted: accepted, total: allItems.length }
    : handoffs.summary;

  return (
    <HandoffsWorkspace
      mode="inbox"
      queueItems={queueItems}
      allItems={allItems}
      summary={summary}
      scenario={scenario}
    />
  );
}

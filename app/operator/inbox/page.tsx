import { InboxTable } from "@/components/operator/inbox-table";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  const { scenario } = await searchParams;
  const workbench = await getWorkbench();
  const all = workbench.listQueue();
  const items = scenario ? all.filter((item) => item.scenarioId === scenario) : all;

  return (
    <div>
      <header className="mb-6 flex items-end justify-between gap-8">
        <div>
          <h1 className="text-2xl font-semibold">Operator inbox</h1>
          <p className="mt-2 text-sm text-muted-foreground">Handoffs waiting for verification, co-signature, or escalation.</p>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl font-semibold tabular-nums">{items.length}</div>
          <div className="text-xs text-muted-foreground">items needing action</div>
        </div>
      </header>

      {scenario && (
        <p className="mb-3 text-xs text-muted-foreground">Showing seeded synthetic shipment <span className="font-mono font-semibold text-foreground">{scenario}</span></p>
      )}
      <InboxTable items={items} />
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DispatchItem, DispatchWorkspace } from "@/lib/workbench/operations-types";

const money = (sen: number) => new Intl.NumberFormat("en-MY", { style: "currency", currency: "MYR" }).format(sen / 100);

export function DispatchWorkspaceView() {
  const [workspace, setWorkspace] = useState<DispatchWorkspace | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(true);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (dispatchId?: string, courierId?: string) => {
    if (inFlight.current) return;
    if (dispatchId && !courierId) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(dispatchId ? `/api/operator/dispatches/${encodeURIComponent(dispatchId)}/assign` : "/api/operator/dispatches",
        dispatchId ? {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ courierId }),
        } : { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "Dispatches could not be loaded. Refresh to retry.");
      if (!body || !Array.isArray(body.items) || !Array.isArray(body.couriers)) throw new Error("Dispatch response unavailable. Refresh to retry.");
      setWorkspace(body as DispatchWorkspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dispatches could not be loaded. Refresh to retry.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const awaiting = workspace?.items.filter((item) => item.state === "awaiting_assignment") ?? [];
  const assigned = workspace?.items.filter((item) => item.state === "assigned") ?? [];

  function row(item: DispatchItem) {
    const courier = workspace?.couriers.find((identity) => identity.subject === item.courierId);
    return (
      <tr key={item.dispatchId}>
        <td>
          <p className="font-mono text-xs font-semibold">{item.waybillNo}</p>
          <p className="mt-1 text-xs text-muted-foreground">{item.source === "online" ? "Online request" : "Registered-address request"}</p>
          <time className="mt-1 block text-xs text-muted-foreground" dateTime={item.createdAt}>{item.createdAt}</time>
        </td>
        <td><p className="text-sm">{item.originLabel}</p><p className="mt-1 text-xs text-muted-foreground">Sender reference</p></td>
        <td><p className="text-sm">{item.destinationLabel}</p><p className="mt-1 text-xs text-muted-foreground">Delivery reference</p></td>
        <td><p className="text-xs">{item.originDepot} / {item.destinationDepot}</p><p className="mt-1 text-xs text-muted-foreground">Simulated depots</p></td>
        <td className="font-mono text-xs tabular-nums">{money(item.declaredValueSen)}</td>
        <td>
          {item.state === "assigned" ? (
            <><p className="text-sm font-medium">Assigned to {courier?.label ?? item.courierId}</p>{!item.available && <p className="mt-1 text-xs text-muted-foreground">Live workflow unavailable after restart; assignment retained.</p>}</>
          ) : !item.available ? (
            <p className="text-xs text-muted-foreground">Workflow unavailable. Assignment is read-only.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label={`Courier for ${item.waybillNo}`}
                value={selection[item.dispatchId] ?? ""}
                disabled={pending}
                onChange={(event) => setSelection((current) => ({ ...current, [item.dispatchId]: event.target.value }))}
                className="h-9 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <option value="">Select demo courier</option>
                {workspace?.couriers.map((identity) => <option key={identity.subject} value={identity.subject}>{identity.label} ({identity.subject})</option>)}
              </select>
              <Button disabled={pending || !selection[item.dispatchId]} onClick={() => void load(item.dispatchId, selection[item.dispatchId])}><UserPlus data-icon="inline-start" />Assign courier</Button>
            </div>
          )}
        </td>
      </tr>
    );
  }

  function table(items: DispatchItem[]) {
    return (
      <div className="mt-3 overflow-x-auto">
        <table className="operator-table min-w-[64rem]">
          <thead><tr><th>Shipment</th><th>Sender</th><th>Delivery</th><th>Depots</th><th>Declared value</th><th>Courier assignment</th></tr></thead>
          <tbody>{items.map(row)}</tbody>
        </table>
      </div>
    );
  }

  return (
    <section aria-label="Dispatch assignments" aria-busy={pending} className="mt-6 min-w-0 border-y py-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-base font-semibold">Awaiting courier assignment</h2>
          {workspace && <span className="font-mono text-sm tabular-nums">{awaiting.length}</span>}
          <span className="text-xs text-muted-foreground">Synthetic shipments / demo couriers</span>
        </div>
        <Button variant="outline" size="icon-sm" aria-label="Refresh dispatches" title="Refresh dispatches" disabled={pending} onClick={() => void load()}><RefreshCw /></Button>
      </header>
      {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
      {pending && <p role="status" className="mt-3 text-xs text-muted-foreground">Loading dispatches...</p>}
      {awaiting.length > 0 ? table(awaiting) : workspace && <p className="mt-3 text-sm text-muted-foreground">No shipments awaiting assignment.</p>}
      {assigned.length > 0 && (
        <details className="mt-4 border-t pt-3" aria-label="Assigned dispatch history">
          <summary className="cursor-pointer text-sm font-semibold">Assigned dispatch history ({assigned.length})</summary>
          {table(assigned)}
        </details>
      )}
    </section>
  );
}

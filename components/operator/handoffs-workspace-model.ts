import type { HandoffSummary } from "@/lib/workbench";

export type HandoffMode = "inbox" | "all";

export function workspaceMetrics(queue: HandoffSummary[], all: HandoffSummary[]) {
  return {
    queue: queue.length,
    accepted: all.filter((item) => item.decision === "accept" && item.sealed).length,
    total: all.length,
    refused: queue.filter((item) => item.inboxGroup === "refused").length,
    waiting: queue.filter((item) => item.inboxGroup === "waiting").length,
    patternCouriers: new Set(
      queue.filter((item) => item.inboxGroup === "pattern").map((item) => item.courier.courierId),
    ).size,
  };
}

export function filterAndSortHandoffs(items: HandoffSummary[], query: string): HandoffSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = needle
    ? items.filter((item) =>
        [
          item.parcel.waybillNo,
          item.parcel.epc,
          item.courier.displayName,
          item.courier.courierId,
          item.eventId,
          item.scenarioId,
        ].some((value) => value.toLocaleLowerCase().includes(needle)),
      )
    : items;

  return filtered
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.priority - a.item.priority || a.index - b.index)
    .map(({ item }) => item);
}

export function detailHref(eventId: string, mode: HandoffMode): string {
  return `/operator/handoffs/${encodeURIComponent(eventId)}?from=${mode}`;
}

export function handoffBackLink(from: string | undefined): { href: string; label: string } {
  return from === "all"
    ? { href: "/operator/handoffs", label: "Back to all handoffs" }
    : { href: "/operator/inbox", label: "Back to inbox" };
}

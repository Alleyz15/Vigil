"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Search, ShieldAlert, Timer, UsersRound } from "lucide-react";
import type { HandoffSummary } from "@/lib/workbench";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AxisPair } from "./axis-pair";
import { HandoffTable } from "./handoff-table";
import { InboxTable } from "./inbox-table";
import {
  detailHref,
  filterAndSortHandoffs,
  type HandoffMode,
  workspaceMetrics,
} from "./handoffs-workspace-model";
import { HandoffStateBadge } from "./status-badge";

type Summary = {
  automaticallyAccepted: number;
  total: number;
  timeframe: string;
  from: string;
  to: string;
};

export function HandoffsWorkspace({
  mode,
  queueItems,
  allItems,
  summary,
  scenario,
}: {
  mode: HandoffMode;
  queueItems: HandoffSummary[];
  allItems: HandoffSummary[];
  summary: Summary;
  scenario?: string;
}) {
  const [query, setQuery] = useState("");
  const source = mode === "inbox" ? queueItems : allItems;
  const visible = useMemo(() => filterAndSortHandoffs(source, query), [query, source]);
  const metrics = workspaceMetrics(queueItems, allItems);
  const selected = visible[0] ?? null;
  const scenarioQuery = scenario ? `?scenario=${encodeURIComponent(scenario)}` : "";

  return (
    <div>
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-5" aria-label="Handoff summary">
        <Metric label="Queue items" value={String(metrics.queue)} icon={Timer} />
        <Metric label="Automatically accepted" value={`${metrics.accepted} of ${metrics.total}`} tone="accept" />
        <Metric label="Refused" value={String(metrics.refused)} tone="refused" icon={ShieldAlert} />
        <Metric label="Waiting" value={String(metrics.waiting)} tone="waiting" icon={Timer} />
        <Metric label="Pattern couriers" value={String(metrics.patternCouriers)} tone="pattern" icon={UsersRound} />
      </section>

      <div className="mt-4 grid items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="min-w-0 rounded-lg border bg-card">
          <div className="flex flex-wrap items-center gap-3 border-b p-4">
            <div className="flex rounded-md bg-muted p-1" aria-label="Handoff list mode">
              <ModeLink active={mode === "inbox"} href={`/operator/inbox${scenarioQuery}`} label="Inbox queue" count={queueItems.length} />
              <ModeLink active={mode === "all"} href={`/operator/handoffs${scenarioQuery}`} label="All handoffs" count={allItems.length} />
            </div>
            <label className="relative min-w-52 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">Search parcel or courier</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search parcel or courier"
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <span className="rounded-full bg-foreground px-3 py-2 text-xs font-semibold text-background">Priority order</span>
          </div>

          <div className="max-h-[66rem] overflow-auto p-4">
            {mode === "inbox" ? (
              <InboxTable items={visible} detailMode="inbox" />
            ) : (
              <HandoffTable items={visible} summary={summary} showSummary={false} />
            )}
          </div>
        </section>

        <aside className="rounded-lg border bg-card p-4 shadow-sm 2xl:sticky 2xl:top-28">
          <p className="text-xs font-semibold uppercase text-muted-foreground">First in current view</p>
          {selected ? (
            <>
              <div className="mt-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-sm font-semibold">{selected.parcel.waybillNo}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{selected.courier.displayName}</div>
                </div>
                <HandoffStateBadge state={selected.state} provenance={selected.stateProvenance} decision={selected.decision} />
              </div>
              <p className="mt-4 text-sm font-medium leading-5">{selected.shortReason}</p>
              <div className="mt-4 border-y py-4">
                <AxisPair inconsistency={selected.inconsistency} pattern={selected.pattern} variant="feature" coverageLine={selected.coverageLine} />
              </div>
              <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 py-4 text-xs">
                <dt className="text-muted-foreground">Scenario</dt><dd className="font-mono">{selected.scenarioId}</dd>
                <dt className="text-muted-foreground">Business step</dt><dd className="font-medium capitalize">{selected.bizStep}</dd>
                <dt className="text-muted-foreground">Gate basis</dt><dd className="font-medium">{selected.gateBasis?.replaceAll("_", " ") ?? "Unavailable"}</dd>
                <dt className="text-muted-foreground">Sealed</dt><dd className="font-medium">{selected.sealed ? "Yes" : "No"}</dd>
              </dl>
              <Button nativeButton={false} className="w-full" render={<Link href={detailHref(selected.eventId, mode)} />}>
                Open full handoff detail
                <ArrowRight data-icon="inline-end" />
              </Button>
            </>
          ) : (
            <p className="mt-3 text-sm leading-5 text-muted-foreground">No backend record matches this search.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function ModeLink({ active, href, label, count }: { active: boolean; href: string; label: string; count: number }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn("rounded px-3 py-1.5 text-xs font-medium", active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
    >
      {label} <span className="ml-1 font-mono font-semibold">{count}</span>
    </Link>
  );
}

function Metric({ label, value, tone = "default", icon: Icon }: { label: string; value: string; tone?: "default" | "accept" | "refused" | "waiting" | "pattern"; icon?: typeof Timer }) {
  return (
    <div className={cn(
      "rounded-lg border bg-card p-4",
      tone === "accept" && "bg-emerald-50/70",
      tone === "refused" && "bg-red-50/70",
      tone === "waiting" && "bg-amber-50/70",
      tone === "pattern" && "bg-sky-50/70",
    )}>
      <div className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
        {label}
        {Icon && <Icon className="size-4" aria-hidden="true" />}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

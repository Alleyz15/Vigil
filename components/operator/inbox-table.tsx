"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronRight, CircleSlash2 } from "lucide-react";
import type { HandoffSummary } from "@/lib/workbench";
import { INBOX_GROUPS, isPatternHigh, type InboxGroupId } from "@/lib/workbench/inbox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AxisPair } from "./axis-pair";
import { ParcelCell } from "./parcel-cell";
import { HandoffStateBadge } from "./status-badge";

/**
 * The operator's queue, GROUPED rather than filtered.
 *
 * A filter answers "show me only X", and a reviewer opening the inbox does not
 * yet know which X they want. Grouping answers the first question — what is most
 * urgent — without making anyone choose first. The groups and their order come
 * from `lib/workbench/inbox.ts`; each row is in exactly one.
 *
 * Inside the pattern group rows are aggregated BY COURIER. A pattern anomaly is
 * a property of a courier's distribution, not of any one handoff, so listing it
 * per handoff shows a statistic at the wrong grain — thirty-four rows repeating
 * one finding. The aggregate is its correct form; expanding it is for checking.
 */

function ageLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Column widths shared by every group, so the four tables line up as one list.
function Columns() {
  return (
    <colgroup>
      <col className="w-48" />
      <col className="w-48" />
      <col className="w-56" />
      <col />
      <col className="w-60" />
      <col className="w-24" />
      <col className="w-12" />
    </colgroup>
  );
}

export function InboxTable({ items }: { items: HandoffSummary[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ other: false });

  if (items.length === 0) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center border-y text-center">
        <CircleSlash2 className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">No handoffs need action</p>
        <p className="mt-1 text-xs text-muted-foreground">Processed work leaves this queue.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {INBOX_GROUPS.map((group) => {
        const rows = items.filter((item) => item.inboxGroup === group.id);
        if (rows.length === 0) return null;
        const collapsible = group.id === "other";
        const open = !collapsible || expanded.other;
        return (
          <section key={group.id} data-inbox-group={group.id} aria-labelledby={`inbox-${group.id}`}>
            <header className="mb-2 flex items-baseline gap-3">
              {collapsible ? (
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => ({ ...prev, other: !prev.other }))}
                  className="flex items-center gap-1 text-base font-semibold hover:underline"
                  aria-expanded={open}
                  id={`inbox-${group.id}`}
                >
                  <ChevronRight aria-hidden="true" className={cn("size-4 transition-transform", open && "rotate-90")} />
                  {group.title}
                </button>
              ) : (
                <h2 id={`inbox-${group.id}`} className="text-base font-semibold">
                  {group.title}
                </h2>
              )}
              <span className="font-mono text-sm font-semibold tabular-nums">{rows.length}</span>
              <span className="text-xs text-muted-foreground">{group.detail}</span>
            </header>
            {open && <GroupTable groupId={group.id} rows={rows} />}
          </section>
        );
      })}
    </div>
  );
}

function GroupTable({ groupId, rows }: { groupId: InboxGroupId; rows: HandoffSummary[] }) {
  return (
    <div className="overflow-hidden rounded-md bg-card shadow-sm">
      <table className="operator-table table-fixed">
        <Columns />
        <thead>
          <tr>
            <th>Parcel</th>
            <th>Courier</th>
            <th>State</th>
            <th>Reason</th>
            <th>Risk axes · never summed</th>
            <th>Age</th>
            <th aria-label="Open handoff" />
          </tr>
        </thead>
        <tbody>
          {groupId === "pattern"
            ? byCourier(rows).map(([courierId, handoffs]) => (
                <CourierAggregate key={courierId} handoffs={handoffs} />
              ))
            : rows.map((item) => <HandoffRow key={item.eventId} item={item} markPattern />)}
        </tbody>
      </table>
    </div>
  );
}

function byCourier(rows: HandoffSummary[]): Array<[string, HandoffSummary[]]> {
  const map = new Map<string, HandoffSummary[]>();
  for (const row of rows) map.set(row.courier.courierId, [...(map.get(row.courier.courierId) ?? []), row]);
  return [...map.entries()];
}

function HandoffRow({ item, markPattern = false, nested = false }: { item: HandoffSummary; markPattern?: boolean; nested?: boolean }) {
  return (
    <tr>
      <td className={cn(nested && "pl-8")}>
        <ParcelCell item={item} />
        <div className="mt-1 font-mono text-xs text-muted-foreground">{item.scenarioId} · leg {item.legIndex + 1}</div>
      </td>
      <td>
        <div className="text-sm font-medium">{item.courier.displayName}</div>
        <div className="mt-1 font-mono text-xs text-muted-foreground">{item.courier.courierId}</div>
      </td>
      <td>
        <HandoffStateBadge state={item.state} provenance={item.stateProvenance} />
        {!item.sealed && <div className="mt-2 text-xs font-semibold text-amber-800">Nothing sealed</div>}
      </td>
      <td>
        <p className="text-sm font-medium leading-5">{item.shortReason}</p>
        {/* A waiting or refused row can also be a pattern anomaly; it must not be lost by being grouped above it. */}
        {markPattern && isPatternHigh(item.matrixCell) && !item.shortReason.startsWith("Pattern anomaly") && (
          <p className="mt-1 text-xs font-medium text-muted-foreground">Also a pattern anomaly</p>
        )}
      </td>
      <td>
        <AxisPair inconsistency={item.inconsistency} pattern={item.pattern} />
      </td>
      <td className="font-mono text-xs tabular-nums text-muted-foreground">{ageLabel(item.ageMinutes)}</td>
      <td className="text-right">
        <Button
          nativeButton={false}
          size="icon-sm"
          variant="ghost"
          render={<Link href={`/operator/handoffs/${item.eventId}`} aria-label={`Review ${item.parcel.waybillNo}`} />}
        >
          <ArrowRight />
        </Button>
      </td>
    </tr>
  );
}

/**
 * One courier's pattern anomaly as one row, showing the handoff with the highest
 * pattern score as its representative. Expand to see every handoff behind it.
 */
function CourierAggregate({ handoffs }: { handoffs: HandoffSummary[] }) {
  const [open, setOpen] = useState(false);
  const worst = [...handoffs].sort((a, b) => (b.pattern.score ?? -1) - (a.pattern.score ?? -1))[0];
  const patternScores = handoffs.map((h) => h.pattern.score).filter((s): s is number => s !== null);
  const range = patternScores.length ? `${Math.min(...patternScores)}–${Math.max(...patternScores)}` : "n/e";
  const reasons = new Set(handoffs.map((h) => h.shortReason));
  const oldest = Math.max(...handoffs.map((h) => h.ageMinutes));

  return (
    <Fragment>
      <tr data-courier-aggregate={worst.courier.courierId}>
        <td>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="flex items-center gap-1 text-sm font-semibold hover:underline"
          >
            <ChevronRight aria-hidden="true" className={cn("size-4 transition-transform", open && "rotate-90")} />
            {handoffs.length} handoffs
          </button>
          <div className="mt-1 font-mono text-xs text-muted-foreground">{worst.scenarioId} · pattern {range}</div>
        </td>
        <td>
          <div className="text-sm font-medium">{worst.courier.displayName}</div>
          <div className="mt-1 font-mono text-xs text-muted-foreground">{worst.courier.courierId}</div>
        </td>
        <td>
          <HandoffStateBadge state={worst.state} provenance={worst.stateProvenance} />
        </td>
        <td>
          <p className="text-sm font-medium leading-5">{reasons.size === 1 ? worst.shortReason : "Pattern anomaly"}</p>
          <p className="mt-1 text-xs text-muted-foreground">A property of this courier&apos;s work, not of one handoff</p>
        </td>
        <td>
          <AxisPair inconsistency={worst.inconsistency} pattern={worst.pattern} />
        </td>
        <td className="font-mono text-xs tabular-nums text-muted-foreground">{ageLabel(oldest)}</td>
        <td />
      </tr>
      {open && handoffs.map((item) => <HandoffRow key={item.eventId} item={item} nested />)}
    </Fragment>
  );
}

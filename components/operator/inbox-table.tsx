import Link from "next/link";
import { ArrowRight, CircleSlash2 } from "lucide-react";
import type { HandoffSummary } from "@/lib/workbench";
import { Button } from "@/components/ui/button";
import { AxisPair } from "./axis-pair";
import { HandoffStateBadge } from "./status-badge";

function ageLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function InboxTable({ items }: { items: HandoffSummary[] }) {
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
    <div className="overflow-hidden rounded-md border bg-card">
      <table className="operator-table">
        <thead>
          <tr>
            <th>Parcel</th>
            <th>Courier</th>
            <th>State</th>
            <th>Reason</th>
            <th>Risk axes</th>
            <th>Age</th>
            <th aria-label="Open handoff" />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.eventId}>
              <td>
                <Link href={`/operator/handoffs/${item.eventId}`} className="font-mono text-xs font-semibold hover:underline">
                  {item.parcel.waybillNo}
                </Link>
                <div className="mt-1 font-mono text-[10px] text-muted-foreground">{item.scenarioId} · leg {item.legIndex + 1}</div>
              </td>
              <td>
                <div className="text-sm font-medium">{item.courier.displayName}</div>
                <div className="mt-1 font-mono text-[10px] text-muted-foreground">{item.courier.courierId}</div>
              </td>
              <td>
                <HandoffStateBadge state={item.state} />
                {!item.sealed && <div className="mt-2 text-[11px] font-semibold text-amber-800">Nothing sealed</div>}
              </td>
              <td className="max-w-md">
                <p className="text-[13px] leading-5 text-foreground">{item.reason}</p>
                {item.coverageLine && <p className="mt-1 text-[11px] text-muted-foreground">{item.coverageLine}</p>}
              </td>
              <td><AxisPair inconsistency={item.inconsistency} pattern={item.pattern} /></td>
              <td className="font-mono text-xs tabular-nums text-muted-foreground">{ageLabel(item.ageMinutes)}</td>
              <td className="text-right">
                <Button size="icon-sm" variant="ghost" render={<Link href={`/operator/handoffs/${item.eventId}`} aria-label={`Review ${item.parcel.waybillNo}`} />}>
                  <ArrowRight />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

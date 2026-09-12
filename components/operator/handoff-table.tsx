import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { HandoffSummary } from "@/lib/workbench";
import { AxisPair } from "./axis-pair";
import { HandoffStateBadge } from "./status-badge";
import { ProvenanceLabel } from "./provenance-label";

type Summary = {
  automaticallyAccepted: number;
  total: number;
  timeframe: string;
  from: string;
  to: string;
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-MY", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(new Date(value));
}

function basisLabel(value: string | null): string {
  return value?.replaceAll("_", " ") ?? "basis unavailable";
}

export function HandoffTable({ items, summary }: { items: HandoffSummary[]; summary: Summary }) {
  return (
    <div>
      <div className="mb-4 flex items-end justify-between gap-8 border-y bg-card px-4 py-4">
        <div>
          <p className="text-lg font-semibold tabular-nums">
            {summary.automaticallyAccepted} of {summary.total} handoffs automatically accepted
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Fixed demo window · {formatDate(summary.from)} to {formatDate(summary.to)}
          </p>
        </div>
        <p className="max-w-lg text-right text-xs leading-5 text-muted-foreground">
          Automatic acceptance means both independent axes were low and mandate limits passed. Open any row to inspect the sealed basis.
        </p>
      </div>

      <div className="overflow-hidden rounded-md bg-card shadow-sm">
        <table className="operator-table">
          <thead>
            <tr>
              <th>Time / parcel</th>
              <th>Handoff</th>
              <th>State</th>
              <th>Risk axes</th>
              <th>Why</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.eventId}>
                <td>
                  <div className="font-mono text-xs tabular-nums text-muted-foreground">{formatDate(item.eventTime)}</div>
                  <Link href={`/operator/handoffs/${item.eventId}`} className="mt-1 block font-mono text-xs font-semibold hover:underline">
                    {item.parcel.waybillNo}
                  </Link>
                </td>
                <td>
                  <div className="text-sm font-medium capitalize">{item.bizStep}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{item.courier.displayName} · {item.scenarioId}</div>
                </td>
                <td><HandoffStateBadge state={item.state} /></td>
                <td><AxisPair inconsistency={item.inconsistency} pattern={item.pattern} /></td>
                <td className="max-w-sm">
                  {item.state === "accepted" ? (
                    <details className="group">
                      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-primary hover:underline">
                        <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden="true" />
                        Why accepted
                      </summary>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">
                        Gate basis: <span className="font-medium text-foreground">{basisLabel(item.gateBasis)}</span>. {item.coverageLine ?? "Evidence coverage unavailable."}
                      </p>
                    </details>
                  ) : (
                    <p className="text-xs leading-5 text-muted-foreground">{item.reason}</p>
                  )}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    <ProvenanceLabel>synthetic</ProvenanceLabel>
                    <ProvenanceLabel>{item.provenance.pattern.replaceAll("_", " ")}</ProvenanceLabel>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

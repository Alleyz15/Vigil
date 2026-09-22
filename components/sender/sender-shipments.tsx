"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MapPinned, PackageCheck, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import type { SenderShipmentView } from "@/lib/workbench/service";
import type { SenderAddress } from "./sender-form";
import { OnlineCorrectionControl } from "./online-correction-control";

/**
 * Shipments this sender has dispatched, and what they can still do about them.
 *
 * BOTH ACTIONS HERE ARE PRODUCT BEHAVIOUR. Correcting an address is what a
 * merchant does when a customer moves; confirming delivery is the courier's
 * scan arriving. Neither belongs behind the fault-injection panel, and the
 * separation is structural rather than a label asking the viewer to remember
 * which half they are in.
 *
 * THE CORRECTION IS THE POINT. It does not rewrite the delivery point on
 * record — that stays as captured at dispatch, which is exactly the stale
 * record the system is sensitive to. The courier is told; the registry is not.
 */
export function SenderShipments({
  shipments,
  addresses,
}: {
  shipments: SenderShipmentView[];
  addresses: SenderAddress[];
}) {
  const [visibleShipments, setVisibleShipments] = useState(shipments);
  const loadOnline = useCallback(async () => {
    try {
      const response = await fetch("/api/sender/online-shipments");
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.items)) return;
      setVisibleShipments((current) => {
        const onlineIds = new Set(body.items.map((item: SenderShipmentView) => item.runId));
        return [
          ...current.filter((item) => item.kind !== "online" || !onlineIds.has(item.runId)),
          ...body.items,
        ];
      });
    } catch {
      // The server-rendered list remains truthful when the route is unavailable.
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadOnline(), 0);
    const refresh = () => void loadOnline();
    window.addEventListener("vigil:sender-shipments-changed", refresh);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("vigil:sender-shipments-changed", refresh);
    };
  }, [loadOnline]);

  return (
    <section id="pending-deliveries" className="mt-10 scroll-mt-6 border-t pt-6">
      <h2 className="text-lg font-semibold">Awaiting delivery scan</h2>
      <p className="mt-1 max-w-prose text-xs leading-5 text-muted-foreground">
        Pending delivery scans only — not complete shipment history or live tracking.
      </p>
      {visibleShipments.length === 0 && <p className="mt-4 text-sm text-muted-foreground">No pending delivery scans.</p>}

      <ul className="mt-4 flex flex-col gap-3">
        {visibleShipments.map((shipment) => (
          <Shipment key={shipment.runId} shipment={shipment} addresses={addresses} />
        ))}
      </ul>
    </section>
  );
}

function Shipment({
  shipment,
  addresses,
}: {
  shipment: SenderShipmentView;
  addresses: SenderAddress[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<number>(
    addresses.find((a) => a.label !== shipment.recordedAddress)?.index ?? 0,
  );

  const post = (path: string, body?: unknown, then?: (result: Record<string, unknown>) => void) => {
    setError(null);
    startTransition(async () => {
      try {
      const base = shipment.kind === "online" && shipment.shipmentId
        ? `/api/sender/online-shipments/${shipment.shipmentId}`
        : `/api/sender/shipments/${shipment.runId}`;
      const response = await fetch(`${base}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        setError(result?.reason ?? "That did not go through.");
        return;
      }
      if (then) then(result);
      else router.refresh();
      } catch {
        setError("The request could not be confirmed. Reload before retrying; the action may have completed.");
      }
    });
  };

  return (
    <li className="sender-shipment overflow-hidden rounded-lg border bg-card">
      <div className="min-w-0 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="font-mono text-sm">{shipment.waybillNo}</span>
        <span className="text-xs text-muted-foreground">
          RM {(shipment.declaredValueSen / 100).toFixed(2)}
        </span>
      </div>

      <dl className="mt-3 space-y-1.5 text-sm">
        <Row label="Delivery point on record" value={shipment.recordedAddress} />
        {shipment.correction && (
          <Row
            label="Corrected to"
            value={shipment.correction.toLabel}
            hint={`at ${shipment.correction.correctedAt.replace("T", " ").slice(0, 16)} — the courier was told; the record above was not`}
            emphasise
          />
        )}
      </dl>
      </div>
      <div className="min-w-0 border-t p-5">

      {!shipment.correction && (
        <div className="mt-4">
          <span className="flex items-center gap-2 text-xs font-medium">
            <MapPinned aria-hidden="true" className="size-3.5" />
            Correct the recipient address
          </span>
          <p className="mt-1 max-w-prose text-xs leading-5 text-muted-foreground">
            The customer has moved. The courier will be told directly.
          </p>
          {shipment.kind === "online" && shipment.shipmentId ? (
            <OnlineCorrectionControl shipmentId={shipment.shipmentId} onCorrected={() => router.refresh()} />
          ) : <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              aria-label={`Correct address for ${shipment.waybillNo}`}
              value={target}
              onChange={(event) => setTarget(Number(event.target.value))}
              className="h-9 min-w-0 flex-1 rounded-md bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              {addresses
                .filter((a) => a.label !== shipment.recordedAddress)
                .map((a) => (
                  <option key={a.index} value={a.index}>
                    {a.label}
                  </option>
                ))}
            </select>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => post("correct", { addressIndex: target })}
            >
              Correct
            </Button>
          </div>}
        </div>
      )}

      {shipment.correction && <p className="text-xs leading-5 text-muted-foreground">Address correction recorded. The original delivery reference is preserved.</p>}
      </div>
      <div className="min-w-0 space-y-3 border-t bg-amber-50/50 p-5">
        <ProvenanceLabel>Demo control · not product behaviour</ProvenanceLabel>
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
          <span>run {shipment.runId}</span>
          {shipment.fault && <span>injection {shipment.fault}</span>}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">Act on behalf of the courier to submit the held delivery scan.</p>
        <Button
          disabled={pending}
          onClick={() =>
            post("deliver", undefined, (result) =>
              typeof result.eventId === "string" && result.eventId.length > 0
                ? router.push(`/operator/handoffs/${encodeURIComponent(result.eventId)}`)
                : setError("The response has no handoff reference. Reload before retrying."),
            )
          }
        >
          {shipment.correction ? (
            <PackageCheck data-icon="inline-start" />
          ) : (
            <Truck data-icon="inline-start" />
          )}
          {pending ? "Delivering…" : "Courier delivers"}
        </Button>
        <span className="text-xs leading-5 text-muted-foreground">
          {shipment.correction
            ? "To the corrected address. The check will compare it against the record above."
            : "To the address on record."}
        </span>
        <p className="text-xs leading-5 text-muted-foreground">After the scan, open operator detail. The result may be sealed or still awaiting co-signature.</p>
      </div>

      {error && (
          <p role="alert" className="p-5 text-xs leading-5 text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </li>
  );
}

function Row({
  label,
  value,
  hint,
  emphasise,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasise?: boolean;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className={cn("text-sm", emphasise && "font-medium")}>{value}</dd>
      </div>
      {hint && <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{hint}</p>}
    </div>
  );
}

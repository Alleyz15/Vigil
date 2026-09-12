"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MapPinned, PackageCheck, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SenderShipmentView } from "@/lib/workbench/service";
import type { SenderAddress } from "./sender-form";

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
  if (shipments.length === 0) return null;

  return (
    <section className="mt-10">
      <h2 className="text-sm font-semibold">Dispatched</h2>
      <p className="mt-1 max-w-prose text-xs leading-5 text-muted-foreground">
        Out for delivery. The courier has the parcel; the delivery scan has not happened yet.
      </p>

      <ul className="mt-4 flex flex-col gap-3">
        {shipments.map((shipment) => (
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
      const response = await fetch(`/api/sender/shipments/${shipment.runId}/${path}`, {
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
    });
  };

  return (
    <li className="rounded-lg bg-muted/50 p-4">
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

      {!shipment.correction && (
        <div className="mt-4">
          <span className="flex items-center gap-2 text-xs font-medium">
            <MapPinned aria-hidden="true" className="size-3.5" />
            Correct the recipient address
          </span>
          <p className="mt-1 max-w-prose text-xs leading-5 text-muted-foreground">
            The customer has moved. The courier will be told directly.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
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
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          disabled={pending}
          onClick={() =>
            post("deliver", undefined, (result) =>
              router.push(`/operator/handoffs/${encodeURIComponent(String(result.eventId))}`),
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
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs leading-5 text-red-700 dark:text-red-400">
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

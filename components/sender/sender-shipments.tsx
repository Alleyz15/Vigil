"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MapPinned, PackageCheck, RefreshCw, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import type { SenderShipmentView } from "@/lib/workbench/service";
import type { SenderAddress } from "./sender-form";
import { OnlineCorrectionControl } from "./online-correction-control";
import { SimulatedClockLabel } from "@/components/operator/simulated-clock-label";

/**
 * Pending declarations and assigned shipments. Corrections preserve the
 * original reference; correction and demo delivery require assignment.
 */
export function SenderShipments({
  shipments,
  addresses,
  clockAnchorIso,
}: {
  shipments: SenderShipmentView[];
  addresses: SenderAddress[];
  clockAnchorIso?: string;
}) {
  const [visibleShipments, setVisibleShipments] = useState(shipments);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const correctionVersion = useRef(0);
  const loadVersion = useRef(0);
  const applyCorrection = (updated: SenderShipmentView) => {
    correctionVersion.current++;
    setVisibleShipments((current) => current.map((item) => item.runId === updated.runId ? updated : item));
  };
  const loadShipments = useCallback(async () => {
    const version = correctionVersion.current;
    const request = ++loadVersion.current;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/sender/shipments", { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (request !== loadVersion.current || version !== correctionVersion.current) return;
      if (!response.ok || !Array.isArray(body?.items)) throw new Error("Shipment list unavailable");
      setVisibleShipments(body.items);
    } catch {
      if (request === loadVersion.current && version === correctionVersion.current) {
        setLoadError("Pending shipments could not be refreshed. The last loaded list is shown. Try Refresh again.");
      }
    } finally {
      if (request === loadVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadShipments(), 0);
    const refresh = (event: Event) => {
      window.clearTimeout(initialLoad);
      const items = (event as CustomEvent<{ items?: SenderShipmentView[] }>).detail?.items;
      if (Array.isArray(items)) {
        // A mutation snapshot supersedes reads that started before it.
        correctionVersion.current++;
        loadVersion.current++;
        setVisibleShipments(items);
        setLoadError(null);
        setLoading(false);
      } else void loadShipments();
    };
    window.addEventListener("vigil:sender-shipments-changed", refresh);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("vigil:sender-shipments-changed", refresh);
    };
  }, [loadShipments]);

  return (
    <section id="pending-deliveries" className="mt-10 scroll-mt-6 border-t pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Pending shipments</h2>
        <Button variant="outline" disabled={loading} aria-busy={loading} onClick={() => void loadShipments()}>
          <RefreshCw data-icon="inline-start" />
          Refresh
        </Button>
      </div>
      <p className="mt-1 max-w-prose text-xs leading-5 text-muted-foreground">
        Awaiting assignment or delivery scan.
      </p>
      <div className="mt-2"><SimulatedClockLabel anchorIso={clockAnchorIso} /></div>
      {loadError && <p role="alert" className="mt-3 text-sm leading-6 text-red-700 dark:text-red-400">{loadError}</p>}
      {visibleShipments.length === 0 && <p className="mt-4 text-sm text-muted-foreground">No pending shipments.</p>}

      <ul className="mt-4 flex flex-col gap-3">
        {visibleShipments.map((shipment) => (
          <Shipment key={shipment.runId} shipment={shipment} addresses={addresses} onCorrected={applyCorrection} />
        ))}
      </ul>
    </section>
  );
}

function Shipment({
  shipment,
  addresses,
  onCorrected,
}: {
  shipment: SenderShipmentView;
  addresses: SenderAddress[];
  onCorrected: (shipment: SenderShipmentView) => void;
}) {
  const router = useRouter();
  const awaitingAssignment = shipment.assignmentState === "awaiting_assignment";
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
      else if (result.shipment?.correction) onCorrected(result.shipment);
      else setError("The correction was recorded, but its updated shipment was not returned. Reload before retrying.");
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
        <Row label="State" value={awaitingAssignment ? "Awaiting operator assignment" : "Assigned"} />
        {!awaitingAssignment && shipment.assignedCourier && <Row label="Courier" value={shipment.assignedCourier} />}
        <Row label="Delivery point on record" value={shipment.recordedAddress} />
        {shipment.correction && (
          <Row
            label="Corrected to"
            value={shipment.correction.toLabel}
            hint={`at ${shipment.correction.correctedAt.replace("T", " ").slice(0, 16)}${awaitingAssignment ? "" : " — the courier was told; the record above was not"}`}
            emphasise
          />
        )}
      </dl>
      </div>
      {awaitingAssignment ? (
        <div className="min-w-0 border-t p-5 text-sm leading-6">
          <Link href="/operator/handoffs" className="underline underline-offset-2">Open operator assignment</Link>
        </div>
      ) : <>
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
            <OnlineCorrectionControl shipmentId={shipment.shipmentId} onCorrected={onCorrected} />
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
      </>}

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

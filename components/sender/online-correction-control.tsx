"use client";

import { useEffect, useState } from "react";
import { booleanPointInPolygon } from "@turf/turf";
import { MapPinned } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmPoint, normaliseClaim } from "@/lib/shipment/picker";
import { AddressSearch, type SearchCandidate } from "./address-search";
import { ServiceAreaMap } from "./service-area-map";
import { bodyPoint, type PickedPoint, type ServiceAreaView } from "./online-shipment-model";

export function OnlineCorrectionControl({ shipmentId, onCorrected }: { shipmentId: string; onCorrected: () => void }) {
  const [open, setOpen] = useState(false);
  const [area, setArea] = useState<ServiceAreaView | null>(null);
  const [pending, setPending] = useState<PickedPoint | null>(null);
  const [claim, setClaim] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || area) return;
    fetch("/api/sender/service-area")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then(setArea)
      .catch(() => setError("The service area could not be loaded, so no correction can be confirmed."));
  }, [area, open]);

  const setPoint = (point: PickedPoint) => {
    setPending(point);
    setClaim("");
    setError(point.inside ? null : "That point is outside the displayed service area.");
  };
  const pick = (latitude: number, longitude: number) => {
    if (!area) return;
    const point = confirmPoint(latitude, longitude);
    setPoint({ ...point, inside: booleanPointInPolygon([point.longitude, point.latitude], area.area), claim: null, resolved: null });
  };
  const choose = (candidate: SearchCandidate & { selectable: true }, query: string) => {
    if (!area) return;
    setPoint({
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      inside: booleanPointInPolygon([candidate.longitude, candidate.latitude], area.area),
      claim: null,
      resolved: { by: "search", label: candidate.label, ref: candidate.ref, query },
    });
  };
  const confirm = async () => {
    if (!pending?.inside) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/sender/online-shipments/${shipmentId}/correct`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyPoint({ ...pending, claim: normaliseClaim(claim) })),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) return setError(result?.reason ?? "That correction was not recorded.");
      onCorrected();
    } catch {
      setError("The correction could not be confirmed. Reload before retrying.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return <Button variant="outline" onClick={() => setOpen(true)}><MapPinned data-icon="inline-start" />Choose a corrected point</Button>;
  return (
    <div className="mt-3 space-y-3">
      <AddressSearch onChoose={choose} />
      {area ? <ServiceAreaMap area={area} pending={pending} origin={null} destination={null} onPick={pick} /> : <p className="text-sm text-muted-foreground">Loading the service area…</p>}
      {pending?.inside && <div className="space-y-2">
        <label className="block text-xs font-medium" htmlFor={`correction-claim-${shipmentId}`}>Sender&apos;s address note (optional)</label>
        <input id={`correction-claim-${shipmentId}`} value={claim} onChange={(event) => setClaim(event.target.value)} className="h-9 w-full rounded-md border bg-background px-3 text-sm" />
        <Button disabled={busy} onClick={confirm}>Confirm as corrected delivery point</Button>
      </div>}
      {error && <p role="alert" className="text-xs leading-5 text-red-700">{error}</p>}
    </div>
  );
}

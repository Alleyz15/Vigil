"use client";

import { useEffect, useRef, useState } from "react";
import { booleanPointInPolygon } from "@turf/turf";
import { Crosshair, MapPinned, PackagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import { addressLine, confirmPoint, formatCoordinate, normaliseClaim } from "@/lib/shipment/picker";
import { cn } from "@/lib/utils";
import { ServiceAreaMap } from "./service-area-map";
import {
  canConfirm,
  newIdempotencyKey,
  SLOT_LABEL,
  submitRefusal,
  type PickedPoint,
  type ServiceAreaView,
  type SlotName,
} from "./online-shipment-model";

/**
 * DISPATCH TO A POINT SOMEBODY CONFIRMED.
 *
 * The cached-address form above declares against 24 geocoded points. This one
 * takes any coordinate inside the service area, and the whole surface is built
 * around one claim: THE POINT YOU CONFIRM IS THE POINT ON RECORD.
 *
 *   - the coordinate shown is the coordinate stored, rounded once at the click
 *     (about 11 cm) rather than displayed short and kept long;
 *   - nothing snaps it to a road, a building or a cached address;
 *   - no geocoder is called, so the address is NOT RESOLVED and says so — an
 *     invented street for an arbitrary click would be the fabrication rule 3e
 *     bans, and the sender's own words are stored as a claim, never as a
 *     resolved address;
 *   - the generator's 60 m doorstep jitter is not applied: moving a confirmed
 *     point silently is the interface lying about what was confirmed;
 *   - an outside click is answered with the reason and the units that ARE
 *     covered, not with a greyed-out button.
 *
 * After a shipment is created the stored reference is read back and printed
 * beside the confirmed point, because "we did not move it" is a claim, and a
 * claim is worth measuring.
 */
export function OnlineShipmentPanel() {
  const [area, setArea] = useState<ServiceAreaView | null>(null);
  const [areaError, setAreaError] = useState<string | null>(null);

  const [pending, setPending] = useState<PickedPoint | null>(null);
  const [claimDraft, setClaimDraft] = useState("");
  const [slots, setSlots] = useState<Record<SlotName, PickedPoint | null>>({ origin: null, destination: null });

  const [valueRinggit, setValueRinggit] = useState("180.00");
  const [channel, setChannel] = useState("+60119990007");
  const [recipientName, setRecipientName] = useState("");

  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/sender/service-area")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((body: ServiceAreaView) => {
        if (live) setArea(body);
      })
      .catch(() => {
        if (live) setAreaError("The service area could not be loaded, so no point can be confirmed here.");
      });
    return () => {
      live = false;
    };
  }, []);

  const pick = (latitude: number, longitude: number) => {
    if (!area) return;
    const point = confirmPoint(latitude, longitude);
    // The browser's check is a COURTESY — it exists so a person learns
    // immediately rather than after submitting. `createShipment` checks the
    // same boundary server-side and that answer is the one that decides.
    const inside = booleanPointInPolygon([point.longitude, point.latitude], area.area);
    setPending({ ...point, inside, claim: null });
    setClaimDraft("");
    setOutcome(null);
  };

  const confirmInto = (slot: SlotName) => {
    if (!pending) return;
    setSlots((current) => ({ ...current, [slot]: { ...pending, claim: normaliseClaim(claimDraft) } }));
    setPending(null);
    setClaimDraft("");
  };

  const declaredValueSen = Math.round((Number.parseFloat(valueRinggit) || 0) * 100);
  const refusal = submitRefusal(slots.origin, slots.destination, declaredValueSen, channel);

  const submit = async () => {
    if (refusal || !slots.origin || !slots.destination) return;
    setBusy(true);
    setOutcome(null);
    // Minted once and kept across retries of THIS shipment: a dropped
    // connection must return the same parcel, and two parcels to one door are
    // still two parcels.
    idempotencyKey.current ??= newIdempotencyKey(() => globalThis.crypto.randomUUID());
    try {
      const response = await fetch("/api/sender/online-shipments", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey.current },
        body: JSON.stringify({
          origin: bodyPoint(slots.origin),
          destination: bodyPoint(slots.destination),
          declaredValueSen,
          recipientChannel: channel.trim(),
          recipientName: recipientName.trim() || undefined,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!body) {
        setOutcome({ kind: "error", message: "The server's answer could not be read. Reload before retrying." });
        return;
      }
      if (body.status === "created" || (body.status === "replayed" && body.running)) {
        idempotencyKey.current = null;
        setOutcome({
          kind: "created",
          shipmentId: body.shipmentId,
          replayed: body.status === "replayed",
          legs: body.eventIds?.length ?? 0,
          boundaryLabel: body.boundary?.label ?? "",
          stored: await storedReference(body.shipmentId),
        });
        return;
      }
      setOutcome({
        kind: "refused",
        message:
          body.reason ??
          body.error ??
          "That shipment was not created, and the server did not say why — treat it as not created.",
        field: body.field ?? null,
      });
    } catch {
      setOutcome({
        kind: "error",
        message: "The request could not be confirmed. Retrying with the same key returns the same parcel.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="confirm-a-point" className="mt-12 scroll-mt-6">
      <h2 className="text-2xl font-semibold">Dispatch to a point on the map</h2>
      <p className="mt-1 max-w-prose text-sm leading-6 text-muted-foreground">
        Click anywhere inside the outlined area, check the coordinate, and confirm it. The point you
        confirm is the point the courier is measured against — it is not moved, snapped or looked up.
      </p>

      <div className="mt-4">
        <ProvenanceLabel>Confirmed coordinate · no geocoder · no address is guessed</ProvenanceLabel>
      </div>

      {areaError && (
        <p role="alert" className="mt-4 max-w-prose text-sm leading-6 text-red-700 dark:text-red-400">
          {areaError}
        </p>
      )}

      <div className="sender-workspace mt-6">
        <section className="min-w-0 rounded-lg border bg-card p-5">
          <h3 className="text-sm font-semibold">The point you clicked</h3>
          {area ? (
            pending ? (
              <PendingPoint
                point={pending}
                area={area}
                claimDraft={claimDraft}
                onClaimChange={setClaimDraft}
                onConfirm={confirmInto}
              />
            ) : (
              <p className="mt-4 flex items-start gap-2 text-sm leading-6 text-muted-foreground">
                <Crosshair aria-hidden="true" className="mt-1 size-4 shrink-0" />
                Nothing is selected. Click the map to place a point; its latitude and longitude appear
                here before anything is submitted.
              </p>
            )
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">Loading the service area…</p>
          )}

          <div className="mt-6 grid gap-3 border-t pt-5 sm:grid-cols-2">
            {(["origin", "destination"] as const).map((slot) => (
              <Slot
                key={slot}
                name={slot}
                point={slots[slot]}
                onClear={() => setSlots((current) => ({ ...current, [slot]: null }))}
              />
            ))}
          </div>

          <div className="mt-6 grid gap-5 border-t pt-5 sm:grid-cols-2">
            <Labelled label="Declared value">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">RM</span>
                <input
                  aria-label="Declared value for the confirmed-point shipment"
                  inputMode="decimal"
                  value={valueRinggit}
                  onChange={(event) => setValueRinggit(event.target.value)}
                  className="h-10 w-full rounded-md bg-muted/60 px-3 text-sm tabular-nums outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </Labelled>
            <Labelled label="Recipient's registered number">
              <input
                aria-label="Recipient's registered number for the confirmed-point shipment"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
                className="h-10 w-full rounded-md bg-muted/60 px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </Labelled>
          </div>
          <Labelled label="Recipient name (optional)" className="mt-5">
            <input
              aria-label="Recipient name for the confirmed-point shipment"
              value={recipientName}
              onChange={(event) => setRecipientName(event.target.value)}
              placeholder="Left blank, a name is generated"
              className="h-10 w-full rounded-md bg-muted/60 px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </Labelled>

          <div className="mt-7">
            <Button size="lg" disabled={busy || refusal !== null} onClick={submit}>
              <PackagePlus data-icon="inline-start" />
              {busy ? "Creating…" : "Create shipment at these points"}
            </Button>
            {/*
              The button waits only on things the person has not done yet, and
              the sentence says which one. An out-of-area point never reaches
              here: it is answered on the map, with the reason.
            */}
            {refusal && <p className="mt-2 max-w-prose text-xs leading-5 text-muted-foreground">{refusal}</p>}
          </div>

          {outcome && <OutcomePanel outcome={outcome} />}
        </section>

        <div className="min-w-0 overflow-hidden rounded-lg border bg-card">
          <div className="space-y-2 p-5">
            <h3 className="text-sm font-semibold">Where this network delivers</h3>
            <p className="text-xs leading-5 text-muted-foreground">
              The outline is the area a point is checked against — the same geometry the server checks,
              drawn so the range is visible before anything is clicked.
            </p>
          </div>
          {area ? (
            <ServiceAreaMap
              area={area}
              pending={pending}
              origin={slots.origin}
              destination={slots.destination}
              onPick={pick}
            />
          ) : (
            <div className="flex h-[430px] items-center justify-center bg-muted text-sm text-muted-foreground">
              {areaError ?? "Loading the service-area map…"}
            </div>
          )}
          <p className="p-5 text-xs leading-5 text-muted-foreground">
            {area
              ? "The browser checks a click against this geometry as a courtesy. The server checks the " +
                "same boundary when the shipment is created, and that answer is the one that decides."
              : "No boundary has been loaded, so no point can be confirmed."}
          </p>
        </div>
      </div>
    </section>
  );
}

function bodyPoint(point: PickedPoint) {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    ...(point.claim ? { addressClaim: point.claim } : {}),
  };
}

type Outcome =
  | {
      kind: "created";
      shipmentId: string;
      replayed: boolean;
      legs: number;
      boundaryLabel: string;
      stored: { latitude: number; longitude: number } | null;
    }
  | { kind: "refused"; message: string; field: string | null }
  | { kind: "error"; message: string };

/** Read the reference back, so "the point was not moved" is shown rather than asserted. */
async function storedReference(shipmentId: string): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const response = await fetch(`/api/sender/online-shipments/${encodeURIComponent(shipmentId)}`);
    if (!response.ok) return null;
    const body = await response.json();
    const reference = body?.history?.originalReference;
    return reference ? { latitude: reference.latitude, longitude: reference.longitude } : null;
  } catch {
    return null;
  }
}

function PendingPoint({
  point,
  area,
  claimDraft,
  onClaimChange,
  onConfirm,
}: {
  point: PickedPoint;
  area: ServiceAreaView;
  claimDraft: string;
  onClaimChange: (value: string) => void;
  onConfirm: (slot: SlotName) => void;
}) {
  const address = addressLine(normaliseClaim(claimDraft));
  return (
    <div className="mt-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Latitude</dt>
        <dd className="font-mono tabular-nums">{formatCoordinate(point.latitude)}</dd>
        <dt className="text-muted-foreground">Longitude</dt>
        <dd className="font-mono tabular-nums">{formatCoordinate(point.longitude)}</dd>
      </dl>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        These six decimals are the stored value, not a shortened one. Nothing rounds it onto a road or a
        building, and the 60 m doorstep offset the seeded generator uses is not applied here.
      </p>

      <p
        className={cn(
          "mt-4 text-sm leading-6",
          point.inside ? "text-muted-foreground" : "text-amber-800 dark:text-amber-300",
        )}
      >
        {point.inside ? address.text : area.outsideMessage}
      </p>

      {point.inside && (
        <>
          <Labelled label="Address (optional — nothing is looked up)" className="mt-4">
            <input
              aria-label="Address claim for the confirmed point"
              value={claimDraft}
              onChange={(event) => onClaimChange(event.target.value)}
              maxLength={200}
              placeholder="What you would tell the courier, if anything"
              className="h-10 w-full rounded-md bg-muted/60 px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </Labelled>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
            Stored as your own words and never parsed. Left empty, the point travels with no address at
            all — which is the truth about it.
          </p>
        </>
      )}

      {canConfirm(point) && (
        <div className="mt-5 flex flex-wrap gap-2">
          {(["origin", "destination"] as const).map((slot) => (
            <Button
              key={slot}
              variant={slot === "destination" ? "default" : "secondary"}
              onClick={() => onConfirm(slot)}
            >
              <MapPinned data-icon="inline-start" />
              Confirm as {SLOT_LABEL[slot].toLowerCase()}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function Slot({ name, point, onClear }: { name: SlotName; point: PickedPoint | null; onClear: () => void }) {
  return (
    <div className="rounded-md bg-muted/50 p-3">
      <p className="text-xs font-medium text-muted-foreground">{SLOT_LABEL[name]}</p>
      {point ? (
        <>
          <p className="mt-1 font-mono text-sm tabular-nums">
            {formatCoordinate(point.latitude)}, {formatCoordinate(point.longitude)}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{point.claim ?? "Address not resolved"}</p>
          <button type="button" onClick={onClear} className="mt-2 text-xs underline underline-offset-2">
            Clear
          </button>
        </>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">Not confirmed yet</p>
      )}
    </div>
  );
}

function OutcomePanel({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === "created") {
    const stored = outcome.stored;
    return (
      <div className="mt-6 rounded-md border-2 border-emerald-600/60 bg-emerald-500/5 p-4">
        <p className="text-sm font-semibold">
          {outcome.replayed ? "That request was already on file — the same parcel" : "Shipment created"}
        </p>
        <p className="mt-1 break-all font-mono text-xs">{outcome.shipmentId}</p>
        <p className="mt-2 text-sm leading-6">
          {outcome.legs} legs ran through the same agent as a seeded scenario, up to out-for-delivery.
          The delivery scan is a separate act by the courier.
        </p>
        {stored && (
          <p className="mt-2 text-sm leading-6">
            The delivery reference on file reads{" "}
            <span className="font-mono tabular-nums">
              {formatCoordinate(stored.latitude)}, {formatCoordinate(stored.longitude)}
            </span>{" "}
            — read back from the store, not from this form.
          </p>
        )}
        {outcome.boundaryLabel && (
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{outcome.boundaryLabel}</p>
        )}
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          The location is stored; the run is not restartable. A restart keeps the points and says so
          rather than resuming anything.
        </p>
      </div>
    );
  }

  return (
    <p
      role="alert"
      className={cn(
        "mt-6 max-w-prose text-sm leading-6",
        outcome.kind === "refused" ? "text-amber-800 dark:text-amber-300" : "text-red-700 dark:text-red-400",
      )}
    >
      {outcome.kind === "refused" && outcome.field ? `${outcome.field}: ` : ""}
      {outcome.message}
    </p>
  );
}

function Labelled({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <span className="mt-1.5 block">{children}</span>
    </label>
  );
}

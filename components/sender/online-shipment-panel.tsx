"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { booleanPointInPolygon } from "@turf/turf";
import { Crosshair, MapPinned, PackagePlus, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import { GEOCODE_ATTRIBUTION } from "@/lib/geocode/messages";
import { addressLines, confirmPoint, formatCoordinate, normaliseClaim } from "@/lib/shipment/picker";
import { cn } from "@/lib/utils";
import { AddressSearch, type SearchCandidate } from "./address-search";
import { ServiceAreaMap } from "./service-area-map";
import {
  bodyPoint,
  canConfirm,
  newIdempotencyKey,
  SLOT_LABEL,
  submitRefusal,
  type PickedPoint,
  type ServiceAreaView,
  type SlotName,
  withReverseLabel,
} from "./online-shipment-model";
import { ValueConsequence, type SenderPolicy } from "./value-consequence";

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
 *   - a SEARCH (phase two) only proposes points: its candidates wait for a
 *     person to choose one, and the chosen one still has to be confirmed;
 *   - a REVERSE lookup after a click adds a label and never moves the pin; when
 *     it finds nothing the address is NOT RESOLVED and says so — an invented
 *     street would be the fabrication rule 3e bans;
 *   - the geocoder's label and the sender's own words are shown as two lines
 *     under two headings, as they are stored in two columns;
 *   - the generator's 60 m doorstep jitter is not applied: moving a confirmed
 *     point silently is the interface lying about what was confirmed;
 *   - an outside click is answered with the reason and the units that ARE
 *     covered, not with a greyed-out button.
 *
 * After a shipment is created the stored reference is read back and printed
 * beside the confirmed point, because "we did not move it" is a claim, and a
 * claim is worth measuring.
 */
export function OnlineShipmentPanel({ policy }: { policy: SenderPolicy }) {
  const [area, setArea] = useState<ServiceAreaView | null>(null);
  const [areaError, setAreaError] = useState<string | null>(null);

  const [pending, setPending] = useState<PickedPoint | null>(null);
  const [claimDraft, setClaimDraft] = useState("");
  const [slots, setSlots] = useState<Record<SlotName, PickedPoint | null>>({ origin: null, destination: null });

  const [valueRinggit, setValueRinggit] = useState("180.00");
  const [channel, setChannel] = useState("+60119990007");
  const [recipientName, setRecipientName] = useState("");
  const [demoCondition, setDemoCondition] = useState<"normal" | "mock_location">("normal");
  const [simulationMode, setSimulationMode] = useState<"normal" | "randomized">("normal");
  const [seed, setSeed] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState("");
  const seedHelpId = useId();

  const [reverseNote, setReverseNote] = useState<ReverseNote | null>(null);

  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const pendingCreation = useRef<{ key: string; body: string } | null>(null);
  const submitting = useRef(false);
  const copyAttempt = useRef(0);

  // Only a deliberate edit ends an uncertain request. Renders, lookups and
  // retries must keep both its key AND its exact serialized body.
  const editRequest = () => {
    pendingCreation.current = null;
    setOutcome(null);
  };

  const selectMode = (mode: "normal" | "randomized") => {
    if (mode === simulationMode) return;
    editRequest();
    if (mode === "randomized" && seed === null) setSeed(globalThis.crypto.randomUUID());
    setSimulationMode(mode);
    copyAttempt.current++;
    setCopyFeedback("");
  };

  const changeSeed = (next: string) => {
    if (next === seed) return;
    editRequest();
    setSeed(next);
    copyAttempt.current++;
    setCopyFeedback("");
  };

  const copySeed = async () => {
    const attempt = ++copyAttempt.current;
    try {
      await navigator.clipboard.writeText(seed ?? "");
      if (copyAttempt.current === attempt) setCopyFeedback("Seed copied.");
    } catch {
      if (copyAttempt.current === attempt) setCopyFeedback("Could not copy. Select the seed and copy it manually.");
    }
  };

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
    setPending({ ...point, inside, claim: null, resolved: null });
    setClaimDraft("");
    setOutcome(null);
    setReverseNote(null);
    // Only a point that could be confirmed is worth a request. A click is a
    // deliberate act, not typing, so this is not autocomplete — and the server's
    // one queue and its cache still decide whether anything is actually sent.
    if (inside) void lookUpAddress(point);
  };

  const lookUpAddress = async (at: { latitude: number; longitude: number }) => {
    setReverseNote({ at, kind: "looking", text: "Looking up the address at this point…" });
    let note: ReverseNote;
    try {
      const response = await fetch("/api/sender/geocode/reverse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(at),
      });
      const body = await response.json().catch(() => null);
      if (body?.status === "found") {
        // The label is attached to the pending point only if it is still THIS
        // point, and the coordinate is kept from the point, not the answer.
        setPending((current) => withReverseLabel(current, { at, label: body.label, ref: body.ref }));
        note = { at, kind: "done", text: "" };
      } else {
        note = {
          at,
          kind: "failed",
          text: body?.message ?? "The address lookup could not be sent to this server. The coordinate is unchanged.",
        };
      }
    } catch {
      note = { at, kind: "failed", text: "The address lookup could not be sent to this server. The coordinate is unchanged." };
    }
    setReverseNote((current) =>
      current && current.at.latitude === at.latitude && current.at.longitude === at.longitude ? note : current,
    );
  };

  const choose = (candidate: SearchCandidate & { selectable: true }, query: string) => {
    if (!area) return;
    // The candidate's coordinate is already the six-decimal value; the browser
    // re-checks it as a courtesy exactly as it does a click.
    const inside = booleanPointInPolygon([candidate.longitude, candidate.latitude], area.area);
    setPending({
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      inside,
      claim: null,
      resolved: { by: "search", label: candidate.label, ref: candidate.ref, query },
    });
    setClaimDraft("");
    setOutcome(null);
    setReverseNote(null);
  };

  const confirmInto = (slot: SlotName) => {
    if (!pending) return;
    const next = { ...pending, claim: normaliseClaim(claimDraft) };
    if (JSON.stringify(bodyPoint(next)) !== JSON.stringify(slots[slot] && bodyPoint(slots[slot]))) editRequest();
    setSlots((current) => ({ ...current, [slot]: next }));
    setPending(null);
    setClaimDraft("");
  };

  const declaredValueSen = Math.round((Number.parseFloat(valueRinggit) || 0) * 100);
  const refusal = submitRefusal(slots.origin, slots.destination, declaredValueSen, channel);
  const invalidSeed = simulationMode === "randomized" && !/^[A-Za-z0-9_-]{1,80}$/.test(seed ?? "");

  const submit = async () => {
    if (submitting.current || refusal || invalidSeed || !slots.origin || !slots.destination) return;
    submitting.current = true;
    setBusy(true);
    setOutcome(null);
    // Freeze the body before sending. A lost or unreadable response says
    // nothing about whether creation succeeded, so retry this exact request.
    pendingCreation.current ??= {
      key: newIdempotencyKey(() => globalThis.crypto.randomUUID()),
      body: JSON.stringify({
        origin: bodyPoint(slots.origin),
        destination: bodyPoint(slots.destination),
        declaredValueSen,
        recipientChannel: channel.trim(),
        recipientName: recipientName.trim() || undefined,
        demoCondition,
        ...(simulationMode === "randomized" ? { simulation: { mode: "randomized", seed, version: "signals-v1" } } : {}),
      }),
    };
    const request = pendingCreation.current;
    try {
      const response = await fetch("/api/sender/online-shipments", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": request.key },
        body: request.body,
      });
      const body = await response.json().catch(() => null);
      const created = response.ok && (body?.status === "created" || (body?.status === "replayed" && (body.awaitingAssignment || body.running)));
      // Creation is authoritative for the list even if the sender has edited
      // the draft meanwhile. Its receipt must never describe that newer draft.
      if (created) {
        window.dispatchEvent(new CustomEvent("vigil:sender-shipments-changed", { detail: { items: body.items } }));
      }
      if (pendingCreation.current !== request) return;
      if (!body) {
        setOutcome({ kind: "error", message: "The server's answer could not be read. Retry without editing to resend the same key and body. Editing starts a new request." });
        return;
      }
      if (created) {
        pendingCreation.current = null;
        const receipt: Extract<Outcome, { kind: "created" }> = {
          kind: "created",
          shipmentId: body.shipmentId,
          replayed: body.status === "replayed",
          awaitingAssignment: body.awaitingAssignment === true,
          boundaryLabel: body.boundary?.label ?? "",
          stored: null,
        };
        setOutcome(receipt);
        const stored = await storedReference(body.shipmentId);
        setOutcome((current) => current === receipt ? { ...current, stored } : current);
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
      if (pendingCreation.current !== request) return;
      setOutcome({
        kind: "error",
        message: "The request could not be confirmed. Retry without editing to resend the same key and body. Editing starts a new request.",
      });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <section id="confirm-a-point" className="mt-12 scroll-mt-6">
      <h2 className="text-2xl font-semibold">Dispatch to a point on the map</h2>
      <p className="mt-1 max-w-prose text-sm leading-6 text-muted-foreground">
        Search for an address or click anywhere inside the outlined area, check the coordinate, and
        confirm it. The point you confirm is the point the courier is measured against — a lookup can
        label it, but nothing moves or snaps it.
      </p>

      <div className="mt-4">
        <ProvenanceLabel>Confirmed coordinate · addresses from Nominatim are labels · nothing is guessed</ProvenanceLabel>
      </div>

      {areaError && (
        <p role="alert" className="mt-4 max-w-prose text-sm leading-6 text-red-700 dark:text-red-400">
          {areaError}
        </p>
      )}

      <div className="sender-workspace mt-6">
        <section className="min-w-0 rounded-lg border bg-card p-5">
          <h3 className="text-sm font-semibold">Find an address</h3>
          <div className="mt-3">
            <AddressSearch onChoose={choose} />
          </div>

          <h3 className="mt-6 border-t pt-5 text-sm font-semibold">The pending point</h3>
          {area ? (
            pending ? (
              <PendingPoint
                point={pending}
                area={area}
                reverseNote={reverseNote}
                claimDraft={claimDraft}
                onClaimChange={setClaimDraft}
                onConfirm={confirmInto}
              />
            ) : (
              <p className="mt-4 flex items-start gap-2 text-sm leading-6 text-muted-foreground">
                <Crosshair aria-hidden="true" className="mt-1 size-4 shrink-0" />
                Nothing is selected. Choose a search result or click the map; the latitude and longitude
                appear here before anything is submitted.
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
                onClear={() => {
                  editRequest();
                  setSlots((current) => ({ ...current, [slot]: null }));
                }}
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
                  onChange={(event) => {
                    if (event.target.value !== valueRinggit) editRequest();
                    setValueRinggit(event.target.value);
                  }}
                  className="h-10 w-full rounded-md bg-muted/60 px-3 text-sm tabular-nums outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </Labelled>
            <Labelled label="Recipient's registered number">
              <input
                aria-label="Recipient's registered number for the confirmed-point shipment"
                value={channel}
                onChange={(event) => {
                  if (event.target.value !== channel) editRequest();
                  setChannel(event.target.value);
                }}
                className="h-10 w-full rounded-md bg-muted/60 px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </Labelled>
          </div>
          <Labelled label="Recipient name (optional)" className="mt-5">
            <input
              aria-label="Recipient name for the confirmed-point shipment"
              value={recipientName}
              onChange={(event) => {
                if (event.target.value !== recipientName) editRequest();
                setRecipientName(event.target.value);
              }}
              placeholder="Left blank, a name is generated"
              className="h-10 w-full rounded-md bg-muted/60 px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </Labelled>

          <fieldset className="mt-5 rounded-md border bg-muted/30 p-3">
            <legend className="px-1 text-xs font-semibold">Simulation controls</legend>
            <div className="mt-1 flex w-fit flex-wrap gap-1 rounded-md border bg-card p-1">
              <button
                type="button"
                aria-pressed={simulationMode === "normal"}
                onClick={() => selectMode("normal")}
                className={cn(
                  "min-h-9 rounded px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring",
                  simulationMode === "normal" ? "bg-foreground text-background" : "text-muted-foreground",
                )}
              >
                Normal scan
              </button>
              <button
                type="button"
                aria-pressed={simulationMode === "randomized"}
                onClick={() => selectMode("randomized")}
                className={cn(
                  "min-h-9 rounded px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring",
                  simulationMode === "randomized" ? "bg-foreground text-background" : "text-muted-foreground",
                )}
              >
                Randomized scenario
              </button>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Normal scan is the isolated baseline control. Normal does not guarantee a sealed handoff:
              evidence, authorization and any required operator co-sign still apply.
            </p>
            {simulationMode === "randomized" && (
              <div className="mt-4 space-y-3">
                <p className="text-xs leading-5 text-muted-foreground">
                  Randomized scenarios sample simulated conditions and continuous simulated courier history
                  within the same courier run. Checks may accept, flag, or report insufficient evidence;
                  a random scenario does not guarantee an alert.
                </p>
                <Labelled label="Simulation seed">
                  <input
                    aria-label="Simulation seed"
                    aria-describedby={seedHelpId}
                    aria-invalid={invalidSeed}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={seed ?? ""}
                    onChange={(event) => changeSeed(event.target.value)}
                    className="h-10 w-full rounded-md bg-muted/60 px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </Labelled>
                <p id={seedHelpId} className={cn("text-xs leading-5", invalidSeed ? "text-red-700 dark:text-red-400" : "text-muted-foreground")}>
                  Use 1–80 letters, numbers, underscores (_) or hyphens (-). Profile: signals-v1.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" onClick={() => changeSeed(globalThis.crypto.randomUUID())}>Generate new seed</Button>
                  <Button type="button" variant="outline" disabled={invalidSeed} onClick={copySeed}>Copy seed</Button>
                </div>
                <p role="status" className="text-xs leading-5 text-muted-foreground">{copyFeedback}</p>
                <p className="text-xs leading-5 text-muted-foreground">
                  Choose the seed before creation. Replaying evidence requires the same seed, confirmed inputs,
                  profile version and courier context. A seed alone does not reproduce new shipment IDs or keys.
                </p>
              </div>
            )}
            <details className="mt-4 border-t pt-3">
              <summary className="cursor-pointer text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring">Advanced demo controls</summary>
              <label className="mt-3 flex min-h-9 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={demoCondition === "mock_location"}
                  onChange={(event) => {
                    editRequest();
                    setDemoCondition(event.target.checked ? "mock_location" : "normal");
                  }}
                  className="size-4 accent-amber-700"
                />
                <ShieldAlert className="size-4" aria-hidden="true" />
                Mock location app
              </label>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Independent of the selected mode. This reports the handset&apos;s mock-location flag so I7 can
                detect it. It does not invent cell or WiFi reference IDs, and it never sets the verdict directly.
              </p>
            </details>
          </fieldset>

          <ValueConsequence policy={policy} declaredValueSen={declaredValueSen} />

          <div className="mt-7">
            <Button size="lg" disabled={busy || refusal !== null || invalidSeed} onClick={submit}>
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

/** The state of the reverse lookup for the pending point. */
type ReverseNote = { at: { latitude: number; longitude: number }; kind: "looking" | "failed" | "done"; text: string };

type Outcome =
  | {
      kind: "created";
      shipmentId: string;
      replayed: boolean;
      awaitingAssignment: boolean;
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
  reverseNote,
  claimDraft,
  onClaimChange,
  onConfirm,
}: {
  point: PickedPoint;
  area: ServiceAreaView;
  reverseNote: ReverseNote | null;
  claimDraft: string;
  onClaimChange: (value: string) => void;
  onConfirm: (slot: SlotName) => void;
}) {
  const lines = addressLines({ claim: normaliseClaim(claimDraft), resolved: point.resolved });
  const note =
    reverseNote && reverseNote.at.latitude === point.latitude && reverseNote.at.longitude === point.longitude
      ? reverseNote
      : null;
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

      {point.inside ? (
        <div className="mt-4">
          {lines.resolved ? (
            <ResolvedLine heading={lines.resolved.heading} label={lines.resolved.label} by={lines.resolved.by} />
          ) : note?.kind === "looking" ? (
            <p className="text-sm leading-6 text-muted-foreground">{note.text}</p>
          ) : note?.kind === "failed" ? (
            <p role="status" className="text-sm leading-6 text-amber-800 dark:text-amber-300">
              {note.text}
            </p>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">{lines.unresolved}</p>
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm leading-6 text-amber-800 dark:text-amber-300">{area.outsideMessage}</p>
      )}

      {point.inside && (
        <>
          <Labelled label="Your own words (optional — stored as written, never looked up)" className="mt-4">
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
            Kept apart from any resolved address: this line is yours, the one above is the geocoder&apos;s.
            Left empty, nothing is stored in its place.
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
          <SlotAddress point={point} />
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

/**
 * THE GEOCODER'S LINE. Headed with the provider's name and set in its own
 * treatment, so it cannot be read as something the sender wrote.
 */
function ResolvedLine({ heading, label, by }: { heading: string; label: string; by: "search" | "reverse" }) {
  return (
    <div className="border-l-2 border-emerald-700/50 pl-3">
      <p className="text-xs font-medium text-muted-foreground">
        {heading} · {by === "search" ? "chosen search result" : "looked up at this point"}
      </p>
      <p className="mt-0.5 text-sm leading-6">{label}</p>
      <p className="text-xs leading-5 text-muted-foreground">{GEOCODE_ATTRIBUTION}</p>
    </div>
  );
}

/** A confirmed slot's address: the resolved line and the claim, each under its own heading. */
function SlotAddress({ point }: { point: PickedPoint }) {
  const lines = addressLines({ claim: point.claim, resolved: point.resolved });
  return (
    <div className="mt-1 space-y-1.5 text-xs leading-5">
      {lines.resolved && (
        <p className="border-l-2 border-emerald-700/50 pl-2" data-line="resolved">
          <span className="block text-muted-foreground">{lines.resolved.heading}</span>
          <span>{lines.resolved.label}</span>
        </p>
      )}
      {lines.claim && (
        <p className="border-l-2 border-dashed border-amber-700/60 pl-2" data-line="claim">
          <span className="block text-muted-foreground">{lines.claim.heading}</span>
          <span className="italic">&ldquo;{lines.claim.text}&rdquo;</span>
        </p>
      )}
      {lines.unresolved && <p className="text-muted-foreground">{lines.unresolved}</p>}
    </div>
  );
}

function OutcomePanel({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === "created") {
    const stored = outcome.stored;
    return (
      <div role="status" className="mt-6 rounded-md border-2 border-emerald-600/60 bg-emerald-500/5 p-4">
        <p className="text-sm font-semibold">
          {outcome.replayed ? "That request was already on file — the same parcel" : "Shipment created"}
        </p>
        <p className="mt-1 break-all font-mono text-xs">{outcome.shipmentId}</p>
        <p className="mt-2 text-sm leading-6">
          {outcome.awaitingAssignment
            ? "Awaiting operator assignment. Collection begins after a courier is assigned."
            : "A courier is assigned. The delivery scan is a separate act by the courier."}
        </p>
        {outcome.awaitingAssignment && (
          <Link href="/operator/handoffs" className="mt-2 inline-block text-sm underline underline-offset-2">Open operator assignment</Link>
        )}
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
        {!outcome.awaitingAssignment && <p className="mt-2 text-xs leading-5 text-muted-foreground">
          The location is stored; the run is not restartable. A restart keeps the points and says so
          rather than resuming anything.
        </p>}
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

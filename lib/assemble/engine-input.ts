import { and, desc, eq, lt } from "drizzle-orm";
import type { VigilDb } from "@/lib/db/client";
import { events, parcels, referenceSites } from "@/lib/db/schema";
import { DEFAULT_THRESHOLDS } from "@/lib/engine";
import type { EngineInput, PreviousEvent, ReferenceSite } from "@/lib/engine/types";
import { type EpcisEvent, EpcisEvent as EpcisEventSchema, type GeoPoint, epcsOf, vigilSignalsOf } from "@/lib/epcis";
import type { CourierMandate } from "@/lib/mandate/schema";
import { type Assembled, emptyResolution, missing, resolved } from "./types";

/**
 * Assemble the axis-1 input for one event.
 *
 * Anything not found is reported as missing and left `undefined`, never
 * substituted. lib/engine turns an absent input into `not_evaluated`, which is
 * how a courier in a tunnel stays distinguishable from a courier spoofing GPS.
 */
export function assembleEngineInput(
  db: VigilDb,
  event: EpcisEvent,
  options: {
    courier?: { courierId: string; boundDeviceId?: string | null };
    mandate?: CourierMandate;
    thresholds?: EngineInput["thresholds"];
  } = {},
): Assembled<EngineInput> {
  const resolution = emptyResolution();
  const epc = epcsOf(event)[0];

  const parcel = epc ? loadParcel(db, epc, resolution) : undefined;
  const previous = epc ? loadPreviousEvent(db, epc, event, resolution) : undefined;
  const sites = loadReferenceSites(db, event, resolution);

  return {
    input: {
      event,
      sensor: vigilSignalsOf(event),
      courier: options.courier,
      mandate: options.mandate,
      parcel,
      previous,
      referenceSites: sites,
      thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
    },
    resolution,
  };
}

function loadParcel(db: VigilDb, epc: string, resolution: ReturnType<typeof emptyResolution>) {
  const row = db.select().from(parcels).where(eq(parcels.epc, epc)).get();
  if (!row) {
    missing(resolution, "parcel", `no parcel on file for ${epc}`);
    return undefined;
  }

  // Both coordinates or neither. Half a point is not a location, and a parcel
  // with one coordinate would silently place the recipient on the equator.
  const recipientPoint: GeoPoint | undefined =
    row.recipientLat !== null && row.recipientLng !== null
      ? { latitude: row.recipientLat, longitude: row.recipientLng }
      : undefined;

  if (!recipientPoint) {
    missing(resolution, "recipientPoint", `parcel ${epc} has no recipient coordinates on file`);
  } else {
    resolved(resolution, "recipientPoint");
  }

  resolved(resolution, `parcel ${epc}`);
  return { epc, recipientPoint };
}

/**
 * The preceding event for this parcel.
 *
 * Range scan on `events_epc_time_idx` (primary_epc, event_time), taking the
 * latest row strictly before this one. The scan coordinates and battery level
 * live inside the stored EPCIS payload rather than in columns, so the row is
 * parsed back through the schema — a denormalised copy could drift from the
 * evidence it was copied out of.
 */
function loadPreviousEvent(
  db: VigilDb,
  epc: string,
  event: EpcisEvent,
  resolution: ReturnType<typeof emptyResolution>,
): PreviousEvent | undefined {
  const row = db
    .select()
    .from(events)
    .where(and(eq(events.primaryEpc, epc), lt(events.eventTime, event.eventTime)))
    .orderBy(desc(events.eventTime))
    .limit(1)
    .get();

  if (!row) {
    missing(resolution, "previous", `no earlier event for ${epc}; this is the first in its timeline`);
    return undefined;
  }

  const parsed = EpcisEventSchema.safeParse(JSON.parse(row.payloadJson));
  if (!parsed.success) {
    missing(resolution, "previous", `stored event ${row.eventId} no longer satisfies the schema`);
    return undefined;
  }

  const signals = vigilSignalsOf(parsed.data);
  resolved(resolution, `previous event ${row.eventId}`);

  return {
    eventTime: row.eventTime,
    disposition: parsed.data.disposition,
    bizStep: parsed.data.bizStep,
    point: signals?.gps?.point,
    batteryPercent: signals?.battery?.levelPercent,
  };
}

/**
 * Known locations for the positioning sources this event observed.
 *
 * Only sites the event actually reported are looked up: I1 asks whether THIS
 * GPS fix contradicts THIS serving cell, not whether it is near some tower.
 *
 * An empty result is reported as missing, so I1 comes back `not_evaluated`.
 * Fabricating a site here would invent the very contradiction the rule exists
 * to detect.
 */
function loadReferenceSites(
  db: VigilDb,
  event: EpcisEvent,
  resolution: ReturnType<typeof emptyResolution>,
): EngineInput["referenceSites"] {
  const signals = vigilSignalsOf(event);
  if (!signals) {
    missing(resolution, "referenceSites", "the event carried no sensor signals to locate");
    return undefined;
  }

  let cell: ReferenceSite | undefined;
  if (signals.cell) {
    const siteId = `${signals.cell.mcc}-${signals.cell.mnc}-${signals.cell.lac}-${signals.cell.cellId}`;
    const row = db.select().from(referenceSites).where(eq(referenceSites.siteId, siteId)).get();
    if (row) {
      cell = { id: row.siteId, point: { latitude: row.lat, longitude: row.lng } };
      resolved(resolution, `cell site ${siteId}`);
    } else {
      missing(resolution, "referenceSites.cell", `cell ${siteId} is not in the site registry`);
    }
  }

  const wifi: ReferenceSite[] = [];
  for (const observed of signals.wifi ?? []) {
    const row = db.select().from(referenceSites).where(eq(referenceSites.siteId, observed.bssid)).get();
    if (row) {
      wifi.push({ id: row.siteId, point: { latitude: row.lat, longitude: row.lng } });
    }
  }
  if (wifi.length > 0) {
    resolved(resolution, `${wifi.length} WiFi site(s)`);
  } else if ((signals.wifi ?? []).length > 0) {
    missing(resolution, "referenceSites.wifi", "none of the observed WiFi networks are in the site registry");
  }

  if (!cell && wifi.length === 0) {
    missing(
      resolution,
      "referenceSites",
      "no independently-located positioning source could be resolved for this event",
    );
    return undefined;
  }

  return { cell, wifi: wifi.length > 0 ? wifi : undefined };
}

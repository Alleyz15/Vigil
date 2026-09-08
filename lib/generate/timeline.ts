import { EpcisEvent, type GeoPoint } from "@/lib/epcis";
import { type Rng, isoAt, jitterPoint } from "./rng";
import {
  type GeneratedCourier,
  type GeneratedParcel,
  type GeneratedWorld,
  HUBS,
  addressIndexFor,
} from "./world";

/**
 * A shipment's timeline: the unit of generation.
 *
 * The brief asks for a scenario "from normal activity to a meaningful
 * exception", so the thing generated is a whole journey, not an event. An
 * isolated suspicious event proves nothing — there is no normal to depart from,
 * and half the engine (H1 custody continuity, I3 implied speed, I14 battery)
 * has nothing to compare against.
 *
 * EVERY EVENT IS BUILT THROUGH THE EPCIS SCHEMA, never cast to it. A fixture
 * that bypasses the boundary cannot test the boundary — session 4's lesson,
 * learned from a lat/lng type error that survived three sessions. See CLAUDE.md.
 */

/** The five business steps a parcel passes through before it is delivered. */
export type LegName =
  | "collection"
  | "sortation"
  | "linehaul_departure"
  | "linehaul_arrival"
  | "out_for_delivery"
  | "delivery";

export type LegSpec = {
  name: LegName;
  bizStep: string;
  disposition: string;
  /** Minutes after the timeline's start. */
  offsetMinutes: number;
  /** Where the scan happens. "hub" | "destination_hub" | "recipient". */
  where: "origin_hub" | "destination_hub" | "recipient";
};

/**
 * The normal shape of a Klang Valley next-day delivery.
 *
 * Timings are ASSUMPTIONS, not measurements — see docs/DATASET.md. They are
 * chosen to be unremarkable: an afternoon collection, an evening sort, an
 * overnight line-haul, a morning round.
 */
export const NORMAL_LEGS: LegSpec[] = [
  {
    name: "collection",
    bizStep: "urn:epcglobal:cbv:bizstep:receiving",
    disposition: "urn:epcglobal:cbv:disp:active",
    offsetMinutes: 0,
    where: "origin_hub",
  },
  {
    name: "sortation",
    bizStep: "urn:epcglobal:cbv:bizstep:storing",
    disposition: "urn:epcglobal:cbv:disp:in_progress",
    offsetMinutes: 280,
    where: "origin_hub",
  },
  {
    name: "linehaul_departure",
    bizStep: "urn:epcglobal:cbv:bizstep:departing",
    disposition: "urn:epcglobal:cbv:disp:in_transit",
    offsetMinutes: 430,
    where: "origin_hub",
  },
  {
    name: "linehaul_arrival",
    bizStep: "urn:epcglobal:cbv:bizstep:arriving",
    disposition: "urn:epcglobal:cbv:disp:in_possession",
    offsetMinutes: 945,
    where: "destination_hub",
  },
  {
    name: "out_for_delivery",
    bizStep: "urn:epcglobal:cbv:bizstep:transporting",
    disposition: "urn:epcglobal:cbv:disp:in_possession",
    offsetMinutes: 1155,
    where: "destination_hub",
  },
  {
    name: "delivery",
    bizStep: "urn:epcglobal:cbv:bizstep:delivering",
    disposition: "urn:epcglobal:cbv:disp:retail_sold",
    offsetMinutes: 1185,
    where: "recipient",
  },
];

/** Everything a scenario may bend about one leg. */
export type LegOverrides = {
  eventID?: string;
  eventTime?: string;
  recordTime?: string;
  bizStep?: string;
  disposition?: string;
  epc?: string;
  scanPoint?: GeoPoint;
  gpsAccuracyMeters?: number;
  mockLocation?: boolean;
  /** Drop the cell observation, e.g. underground. */
  omitCell?: boolean;
  omitWifi?: boolean;
  /** Report a cell that belongs somewhere else entirely. */
  cellSiteId?: string;
  wifiBssid?: string;
  deviceId?: string;
  motionStationary?: boolean;
  integrityFailed?: boolean;
  batteryPercent?: number;
  omitPod?: boolean;
  photoExifCaptureTime?: string;
};

export type BuiltEvent = {
  leg: LegName;
  legIndex: number;
  event: EpcisEvent;
  /** The raw object, for tests that need to inspect before validation. */
  raw: Record<string, unknown>;
};

/**
 * Build one leg's EPCIS event.
 *
 * Signal timestamps are DERIVED from the event time, so a scenario that moves a
 * leg does not accidentally trip I9 (photo age) with a stale hardcoded photo.
 */
export function buildLegEvent(args: {
  world: GeneratedWorld;
  courier: GeneratedCourier;
  parcel: GeneratedParcel;
  leg: LegSpec;
  legIndex: number;
  startMs: number;
  rng: Rng;
  eventIdSeed: string;
  overrides?: LegOverrides;
}): BuiltEvent {
  const { world, courier, parcel, leg, legIndex, startMs, rng, eventIdSeed, overrides = {} } = args;

  const eventMs = startMs + leg.offsetMinutes * 60_000;
  const eventTime = overrides.eventTime ?? isoAt(eventMs);
  const parsedEventMs = Date.parse(eventTime);
  const baseMs = Number.isFinite(parsedEventMs) ? parsedEventMs : eventMs;

  // Ordinary upload latency: seconds, comfortably inside the I5 band.
  const recordTime = overrides.recordTime ?? isoAt(baseMs + rng.int(8, 90) * 1000);

  const addressIndex = addressIndexFor(parcel);
  const sites = world.sitesByAddress[addressIndex];

  const scanPoint =
    overrides.scanPoint ??
    (leg.where === "recipient"
      ? jitterPoint(rng, parcel.recipientPoint, 30)
      : leg.where === "origin_hub"
        ? jitterPoint(rng, HUBS.kl, 40)
        : jitterPoint(rng, HUBS.shahAlam, 40));

  const isDelivery = (overrides.bizStep ?? leg.bizStep) === "urn:epcglobal:cbv:bizstep:delivering";

  // Cell and WiFi are only observable at the recipient address: the reference
  // registry covers addresses, not depots. Away from one, I1 is honestly
  // not_evaluated rather than falsely clean.
  const atAddress = leg.where === "recipient";

  const signals: Record<string, unknown> = {
    deviceId: overrides.deviceId ?? courier.deviceId,
    gps: {
      point: {
        latitude: scanPoint.latitude,
        longitude: scanPoint.longitude,
        accuracyMeters: overrides.gpsAccuracyMeters ?? rng.int(6, 18),
      },
      fixTime: eventTime,
      speedMps: 0,
      mockLocationProvider: overrides.mockLocation ?? false,
    },
    motion: overrides.motionStationary
      ? { windowSeconds: 60, meanAbsDeviationMs2: 0.01, maxAbsDeviationMs2: 0.04 }
      : {
          windowSeconds: 60,
          meanAbsDeviationMs2: rng.float(0.2, 0.9),
          maxAbsDeviationMs2: rng.float(1.0, 2.4),
        },
    integrity: {
      attestationSource: "mocked",
      verdict: overrides.integrityFailed ? "failed" : "passed",
      rootDetected: overrides.integrityFailed ?? false,
      appTampered: false,
    },
    battery: {
      levelPercent: overrides.batteryPercent ?? batteryFor(leg),
      charging: false,
    },
  };

  if (atAddress && !overrides.omitCell) {
    const cellId = overrides.cellSiteId ?? sites.cell;
    signals.cell = parseCellId(cellId, rng);
  }
  if (atAddress && !overrides.omitWifi) {
    signals.wifi = [{ bssid: overrides.wifiBssid ?? sites.wifi, rssiDbm: rng.int(-78, -45) }];
  }

  if (isDelivery && !overrides.omitPod) {
    signals.pod = {
      photoSha256: hashLike(`${eventIdSeed}-photo`),
      photoExifCaptureTime:
        overrides.photoExifCaptureTime ?? isoAt(baseMs - rng.int(10, 120) * 1000),
      otpVerified: true,
      signatureSha256: hashLike(`${eventIdSeed}-sig`),
    };
  }

  const raw: Record<string, unknown> = {
    type: "ObjectEvent",
    eventID: overrides.eventID ?? uuidFrom(eventIdSeed),
    eventTime,
    recordTime,
    eventTimeZoneOffset: "+08:00",
    epcList: [overrides.epc ?? parcel.epc],
    action: "OBSERVE",
    bizStep: overrides.bizStep ?? leg.bizStep,
    disposition: overrides.disposition ?? leg.disposition,
    "vigil:courierId": courier.courierId,
    sensorElementList: [{ "vigil:signals": signals }],
  };

  // Through the schema, not around it.
  return { leg: leg.name, legIndex, event: EpcisEvent.parse(raw), raw };
}

/** A full normal timeline for one parcel. */
export function buildTimeline(args: {
  world: GeneratedWorld;
  courier: GeneratedCourier;
  parcel: GeneratedParcel;
  startMs: number;
  rng: Rng;
  idPrefix: string;
  /** Per-leg overrides, keyed by leg name. This is how a scenario injects. */
  overrides?: Partial<Record<LegName, LegOverrides>>;
  legs?: LegSpec[];
}): BuiltEvent[] {
  const { world, courier, parcel, startMs, rng, idPrefix, overrides = {}, legs = NORMAL_LEGS } = args;

  return legs.map((leg, legIndex) =>
    buildLegEvent({
      world,
      courier,
      parcel,
      leg,
      legIndex,
      startMs,
      rng: rng.derive(`${idPrefix}-${leg.name}`),
      eventIdSeed: `${idPrefix}-${leg.name}`,
      overrides: overrides[leg.name],
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Deterministic identifiers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A UUIDv4-shaped identifier derived from a string.
 *
 * Deterministic on purpose: `randomUUID()` would make the dataset unrepeatable,
 * and the eventID is the ledger's replay nonce, so it has to be stable across
 * regenerations for a scenario to be re-runnable.
 */
export function uuidFrom(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (seed.charCodeAt(i) + i), 0x85ebca6b) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  const body = `${hex(h1)}${hex(h2)}${hex((h1 ^ h2) >>> 0)}${hex((h1 + h2) >>> 0)}`;
  return [
    body.slice(0, 8),
    body.slice(8, 12),
    `4${body.slice(13, 16)}`,
    `8${body.slice(17, 20)}`,
    body.slice(20, 32),
  ].join("-");
}

/** A deterministic 64-hex string, standing in for a real content hash. */
export function hashLike(seed: string): string {
  let h = 0x811c9dc5;
  let out = "";
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < seed.length; j++) {
      h = Math.imul(h ^ (seed.charCodeAt(j) + i), 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

/**
 * Battery level for a leg.
 *
 * MONOTONE WITHIN A SHIFT. Drawing a level independently per leg lets the
 * handset gain charge between scans, which is physically impossible and makes
 * I14 fire on honest timelines — it did, on S6, until this was fixed. The
 * device drains through the depot legs, is charged overnight, and drains again
 * through the delivery round.
 *
 * The drain rate is an ASSUMPTION, not a measurement: see docs/DATASET.md.
 */
function batteryFor(leg: LegSpec): number {
  // The delivery round starts on a fresh charge; the depot legs are the tail of
  // the previous day.
  const shiftStart = leg.offsetMinutes >= 1155 ? 1155 : 0;
  const minutesIntoShift = leg.offsetMinutes - shiftStart;

  // Roughly 4 percentage points an hour with GPS and the radio active.
  //
  // NO JITTER. A random wobble on each reading can make the level go UP between
  // two legs, or drop by less than a point across a long drive — which is
  // exactly the shape I14 exists to catch, so the generator would be
  // manufacturing the contradiction it is supposed to be a control for.
  const drained = 92 - minutesIntoShift * 0.068;
  return Math.max(12, Math.min(99, Math.round(drained)));
}

/** Split a "mcc-mnc-lac-cellid" site id back into its parts. */
function parseCellId(siteId: string, rng: Rng) {
  const [mcc, mnc, lac, cellId] = siteId.split("-").map(Number);
  return { mcc, mnc, lac, cellId, signalDbm: rng.int(-105, -68) };
}

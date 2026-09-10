import {
  EpcisEvent,
  type DeviceRecognitionVerdict,
  type GeoPoint,
} from "@/lib/epcis";
import { recipientChannelFingerprint } from "@/lib/identity/channel";
import type { DeviceEnrollmentEvidence, OtpChallengeEvidence } from "@/lib/engine/types";
import {
  type NoiseLevel,
  type ShipmentNoise,
  displace,
  drawEventNoise,
  planShipmentNoise,
} from "./noise";
import { type Rng, isoAt, jitterPoint } from "./rng";
import {
  ADDRESSES,
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
  /** A first attempt that failed because nobody was in. Noise only. */
  | "delivery_attempt"
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
  /** Exact Play Integrity recognition labels presented by this handset. */
  deviceRecognitionVerdicts?: DeviceRecognitionVerdict[];
  /** Enrollment policy for a replacement device observed on this leg. */
  requiredRecognitionVerdict?: DeviceRecognitionVerdict;
  /** Courier on the independent enrollment row; defaults to the scanning courier. */
  enrollmentCourierId?: string;
  /** Independent channel the OTP service delivered to; never placed in EPCIS. */
  otpRecipientChannel?: string;
  batteryPercent?: number;
  /** The handset was on charge when the scan was taken. */
  batteryCharging?: boolean;
  omitPod?: boolean;
  photoExifCaptureTime?: string;
};

/**
 * What the environment contributes to one leg.
 *
 * Separate from `LegOverrides` on purpose. An override is a SCENARIO'S
 * STATEMENT — "the position reads the doorstep", "the fix is 140 m vague" — and
 * must survive untouched. Noise is the world, and the world is allowed to blur
 * a position the generator produced naturally but not one a scenario asserted.
 */
export type LegNoise = {
  shipment: ShipmentNoise;
  /**
   * The address the courier is ACTUALLY at, when the parcel record is stale.
   * Still picks up the environment's position error, unlike an override.
   */
  trueScanPoint?: GeoPoint;
  /** The cell and access point observable there. */
  sites?: { cell: string; wifi: string };
};

export type BuiltEvent = {
  leg: LegName;
  legIndex: number;
  event: EpcisEvent;
  /** The raw object, for tests that need to inspect before validation. */
  raw: Record<string, unknown>;
  /** Independent server records the assembler resolves; never part of EPCIS. */
  identity?: {
    otpChallenge?: OtpChallengeEvidence;
    deviceEnrollment: DeviceEnrollmentEvidence & { courierId: string; enrolledAt: string };
  };
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
  /**
   * Environmental noise for this leg.
   *
   * A SCENARIO'S OVERRIDES ALWAYS WIN. S1 sets a spoofed position and S6 sets a
   * degraded fix; if the environment perturbed those, the scenario would stop
   * being the case it was written to be. Noise only fills in what the scenario
   * did not state.
   */
  noise?: LegNoise;
}): BuiltEvent {
  const { world, courier, parcel, leg, legIndex, startMs, rng, eventIdSeed, overrides = {} } = args;

  const shipmentNoise = args.noise?.shipment;
  const deviceId = overrides.deviceId ?? courier.deviceId;
  const eventID = overrides.eventID ?? uuidFrom(eventIdSeed);

  const eventMs = startMs + leg.offsetMinutes * 60_000;
  // The DEVICE authors eventTime, so it carries the handset's clock offset.
  // Stable per handset, so it cancels between two legs from the same device —
  // ordinary drift cannot inflate an implied speed, only a swap can.
  const clockOffsetMs = shipmentNoise ? shipmentNoise.clockOffsetSeconds(deviceId) * 1000 : 0;
  const eventTime = overrides.eventTime ?? isoAt(eventMs + clockOffsetMs);
  const parsedEventMs = Date.parse(eventTime);
  const baseMs = Number.isFinite(parsedEventMs) ? parsedEventMs : eventMs;

  const addressIndex = addressIndexFor(parcel);
  const sites = args.noise?.sites ?? world.sitesByAddress[addressIndex];

  // Cell and WiFi are only observable at the recipient address: the reference
  // registry covers addresses, not depots. Away from one, I1 is honestly
  // not_evaluated rather than falsely clean.
  const atAddress = leg.where === "recipient";

  const env = shipmentNoise ? drawEventNoise(rng, shipmentNoise, { atAddress }) : undefined;

  // Ordinary upload latency: seconds, far below the full-shift I5 band. Under
  // noise the handset may have had no uplink at all and queued the scan.
  //
  // The SERVER stamps recordTime, so it is on true time: the divergence the
  // engine measures is the upload wait MINUS the device's clock offset.
  const recordTime =
    overrides.recordTime ??
    isoAt(baseMs - clockOffsetMs + (env?.uploadLatencySeconds ?? rng.int(8, 90)) * 1000);

  const truePoint =
    overrides.scanPoint ??
    (leg.where === "recipient"
      ? jitterPoint(rng, args.noise?.trueScanPoint ?? parcel.recipientPoint, 30)
      : leg.where === "origin_hub"
        ? jitterPoint(rng, HUBS.kl, 40)
        : jitterPoint(rng, HUBS.shahAlam, 40));

  // A scenario's stated position is what the scenario says it is. Only a
  // naturally-generated one picks up the environment's error.
  const scanPoint = env && !overrides.scanPoint ? displace(truePoint, env) : truePoint;

  const isDelivery = (overrides.bizStep ?? leg.bizStep) === "urn:epcglobal:cbv:bizstep:delivering";

  const signals: Record<string, unknown> = {
    deviceId,
    gps: {
      point: {
        latitude: scanPoint.latitude,
        longitude: scanPoint.longitude,
        // The reported figure is a confidence radius, not a measurement of the
        // fix's own error — `env.errorMeters` is drawn separately and lands
        // outside it about a third of the time. That gap is the point.
        accuracyMeters: overrides.gpsAccuracyMeters ?? env?.accuracyMeters ?? rng.int(6, 18),
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
      deviceRecognitionVerdicts:
        overrides.deviceRecognitionVerdicts ?? [courier.requiredRecognitionVerdict],
    },
    battery: {
      levelPercent: overrides.batteryPercent ?? batteryFor(leg),
      charging: overrides.batteryCharging ?? false,
    },
  };

  // Underground there is no serving cell and no access point to see. That is a
  // real absence, and the engine treats it as one.
  const omitCell = overrides.omitCell ?? env?.omitCell ?? false;
  const omitWifi = overrides.omitWifi ?? env?.omitWifi ?? false;

  if (atAddress && !omitCell) {
    const cellId = overrides.cellSiteId ?? sites.cell;
    signals.cell = parseCellId(cellId, rng);
  }
  if (atAddress && !omitWifi) {
    signals.wifi = [{ bssid: overrides.wifiBssid ?? sites.wifi, rssiDbm: rng.int(-78, -45) }];
  }

  if (isDelivery && !overrides.omitPod) {
    const challengeId = uuidFrom(`${eventIdSeed}-otp-challenge`);
    const verificationReceiptId = uuidFrom(`${eventIdSeed}-otp-receipt`);
    signals.pod = {
      photoSha256: hashLike(`${eventIdSeed}-photo`),
      // The photo is taken at the door and the scan happens back at the vehicle.
      // Both are device-authored, so the clock offset cancels and only the walk
      // remains — up the lift, down the corridor, back to the van.
      photoExifCaptureTime:
        overrides.photoExifCaptureTime ??
        isoAt(baseMs - (env?.photoDelaySeconds ?? rng.int(10, 120)) * 1000),
      otpVerified: true,
      otp: { challengeId, verificationReceiptId },
      signatureSha256: hashLike(`${eventIdSeed}-sig`),
    };
  }

  const raw: Record<string, unknown> = {
    type: "ObjectEvent",
    eventID,
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
  const parsed = EpcisEvent.parse(raw);
  const otp = isDelivery && !overrides.omitPod
    ? {
        challengeId: uuidFrom(`${eventIdSeed}-otp-challenge`),
        epc: overrides.epc ?? parcel.epc,
        recipientChannelFingerprint: recipientChannelFingerprint(
          overrides.otpRecipientChannel ?? parcel.recipientPhone,
        ),
        deliveryStatus: "delivered" as const,
        verificationReceiptId: uuidFrom(`${eventIdSeed}-otp-receipt`),
        issuedAt: isoAt(eventMs - 5 * 60_000),
        expiresAt: isoAt(eventMs + 5 * 60_000),
        verifiedAt: isoAt(eventMs - 10_000),
        consumedByEventId: eventID,
      }
    : undefined;

  return {
    leg: leg.name,
    legIndex,
    event: parsed,
    raw,
    identity: {
      otpChallenge: otp,
      deviceEnrollment: {
        deviceId,
        courierId: overrides.enrollmentCourierId ?? courier.courierId,
        requiredRecognitionVerdict:
          overrides.requiredRecognitionVerdict ?? courier.requiredRecognitionVerdict,
        enrolledAt: "2026-09-01T00:00:00+08:00",
      },
    },
  };
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
  /**
   * How rough the world is. 0 is the control and draws no randomness, so a
   * level-0 timeline is byte-identical to the pre-noise dataset that every
   * scenario expectation was written against.
   */
  noiseLevel?: NoiseLevel;
}): BuiltEvent[] {
  const { world, courier, parcel, startMs, rng, idPrefix, overrides = {}, legs = NORMAL_LEGS } = args;

  const shipment = planShipmentNoise(rng, args.noiseLevel ?? 0);
  const plan = shipment
    ? applyEpisodes(legs, shipment, parcel.recipientPhone)
    : { legs, extras: new Map<number, LegOverrides>() };
  const noiseSites = shipment?.episodes.addressCorrection
    ? world.sitesByAddress[
        (addressIndexFor(parcel) + shipment.episodes.addressCorrection.addressOffset) %
          world.sitesByAddress.length
      ]
    : undefined;
  const truePoint = shipment?.episodes.addressCorrection
    ? correctedPoint(parcel, shipment.episodes.addressCorrection)
    : undefined;

  // A repeated leg name would derive the same eventID and the ledger would
  // abort the second one as a replay — the redelivery would look like S3. Only
  // repeats are suffixed, so a timeline without one is unchanged.
  const seen = new Map<LegName, number>();

  return plan.legs.map((leg, legIndex) => {
    const occurrence = (seen.get(leg.name) ?? 0) + 1;
    seen.set(leg.name, occurrence);
    const idSeed = occurrence === 1 ? `${idPrefix}-${leg.name}` : `${idPrefix}-${leg.name}-${occurrence}`;

    const atRecipient = leg.where === "recipient";

    return buildLegEvent({
      world,
      courier,
      parcel,
      leg,
      legIndex,
      startMs,
      rng: rng.derive(idSeed),
      eventIdSeed: idSeed,
      // The scenario's statement wins over the episode's.
      overrides: { ...plan.extras.get(legIndex), ...overrides[leg.name] },
      noise: shipment
        ? {
            shipment,
            trueScanPoint: atRecipient ? truePoint : undefined,
            sites: atRecipient ? noiseSites : undefined,
          }
        : undefined,
    });
  });
}

/**
 * The address the parcel was actually delivered to, when the record is stale.
 *
 * A real address from the world, not a synthetic offset, so it has its own cell
 * and its own access point in the registry. That matters: a courier standing at
 * the real address sees the real address's radio environment, so I1 is
 * genuinely CLEAR and only the distance rules have anything to say. A
 * fabricated point would have manufactured a positioning contradiction that a
 * stale record does not actually produce.
 */
function correctedPoint(
  parcel: GeneratedParcel,
  correction: { kind: "nearby" | "elsewhere"; addressOffset: number },
): GeoPoint {
  const index = (addressIndexFor(parcel) + correction.addressOffset) % ADDRESSES.length;
  const address = ADDRESSES[index];
  const point = { latitude: address.latitude, longitude: address.longitude };

  // A wrong unit number keeps the parcel on the same round; a customer
  // redirecting to their office does not. "nearby" pulls the corrected address
  // most of the way back towards the recorded one.
  if (correction.kind !== "nearby") return point;
  return {
    latitude: parcel.recipientPoint.latitude + (point.latitude - parcel.recipientPoint.latitude) * 0.04,
    longitude: parcel.recipientPoint.longitude + (point.longitude - parcel.recipientPoint.longitude) * 0.04,
  };
}

/**
 * Turn a shipment's episodes into a leg list and per-leg overrides.
 *
 * These are the noise sources that are TIMELINE-SHAPED rather than
 * event-shaped: a scan that was never submitted, a day that had to be repeated,
 * a handset that was swapped halfway through. None of them can be expressed by
 * perturbing a field.
 */
function applyEpisodes(
  legs: LegSpec[],
  shipment: ShipmentNoise,
  recipientChannel: string,
): { legs: LegSpec[]; extras: Map<number, LegOverrides> } {
  const { episodes } = shipment;
  let out = legs;

  // A scan the fleet never submitted. Which one is drawn uniformly; see
  // lib/generate/noise.ts for why that matters to H1.
  if (episodes.missedLeg) {
    const without = out.filter((leg) => leg.name !== episodes.missedLeg);
    // Never empty the timeline: a one-leg list has no missable scan.
    if (without.length > 0 && without.length < out.length) out = without;
  }

  // Nobody in. A failed attempt, then the round again the next day.
  if (episodes.redelivery) out = withRedelivery(out);

  const extras = new Map<number, LegOverrides>();

  // The courier charged the handset partway through the round. I14 declines to
  // judge drain on a charging device — but the level is still HIGHER at the
  // next scan than at the last one, which is a thing a real round does.
  if (episodes.chargedMidShift) {
    const at = out.findIndex((leg) => leg.name === "out_for_delivery");
    if (at >= 0) {
      extras.set(at, {
        batteryCharging: true,
        batteryPercent: clampPercent(batteryFor(out[at]) + episodes.chargeGainPercentPoints),
      });
      for (let i = at + 1; i < out.length; i++) {
        extras.set(i, {
          ...extras.get(i),
          batteryPercent: clampPercent(batteryFor(out[i]) + episodes.chargeGainPercentPoints),
        });
      }
    }
  }

  // A replacement handset: a different device id, a different clock, and a
  // battery that owes nothing to the morning.
  if (episodes.handsetSwap) {
    const at = out.findIndex((leg) => leg.where === "recipient");
    if (at > 0) {
      for (let i = at; i < out.length; i++) {
        extras.set(i, {
          ...extras.get(i),
          deviceId: `${shipment.profile.name}-replacement-handset`,
          deviceRecognitionVerdicts: ["MEETS_BASIC_INTEGRITY"],
          requiredRecognitionVerdict: "MEETS_DEVICE_INTEGRITY",
          batteryPercent: clampPercent(88 - (out[i].offsetMinutes - out[at].offsetMinutes) * 0.068),
        });
      }
    }
  }

  const deliveryAt = out.findIndex((leg) => leg.name === "delivery");
  if (deliveryAt >= 0 && episodes.staleRecipientChannel) {
    extras.set(deliveryAt, {
      ...extras.get(deliveryAt),
      otpRecipientChannel: alternateRecipientChannel(recipientChannel),
    });
  }
  if (deliveryAt >= 0 && episodes.attestationDegraded) {
    extras.set(deliveryAt, {
      ...extras.get(deliveryAt),
      deviceRecognitionVerdicts: ["MEETS_BASIC_INTEGRITY"],
    });
  }

  return { legs: out, extras };
}

/** A synthetic current channel distinct from the stale parcel record. */
function alternateRecipientChannel(channel: string): string {
  const last = Number(channel.at(-1) ?? "0");
  return `${channel.slice(0, -1)}${(last + 1) % 10}`;
}

/** The recipient was out: a failed attempt today, the round again tomorrow. */
function withRedelivery(legs: LegSpec[]): LegSpec[] {
  const at = legs.findIndex((leg) => leg.name === "delivery");
  if (at < 0) return legs;

  const delivery = legs[at];
  const attempt: LegSpec = {
    name: "delivery_attempt",
    // A failed attempt is not a delivery, so it carries no proof of delivery
    // and the delivery-gated rules correctly decline to score it.
    bizStep: "urn:epcglobal:cbv:bizstep:holding",
    disposition: "urn:epcglobal:cbv:disp:in_possession",
    offsetMinutes: delivery.offsetMinutes,
    where: "recipient",
  };

  const outAgain = legs.find((leg) => leg.name === "out_for_delivery");
  const nextDay: LegSpec[] = [
    {
      name: "out_for_delivery",
      bizStep: outAgain?.bizStep ?? "urn:epcglobal:cbv:bizstep:transporting",
      disposition: outAgain?.disposition ?? "urn:epcglobal:cbv:disp:in_possession",
      offsetMinutes: delivery.offsetMinutes + 1440 - 30,
      where: "destination_hub",
    },
    { ...delivery, offsetMinutes: delivery.offsetMinutes + 1440 },
  ];

  return [...legs.slice(0, at), attempt, ...nextDay, ...legs.slice(at + 1)];
}

function clampPercent(value: number): number {
  return Math.max(3, Math.min(99, Math.round(value)));
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
  // the previous day. Taken modulo a day, so a redelivery the following morning
  // is a fresh handset rather than one that has been draining for 24 hours.
  const withinDay = ((leg.offsetMinutes % 1440) + 1440) % 1440;
  const shiftStart = withinDay >= 1155 ? 1155 : 0;
  const minutesIntoShift = withinDay - shiftStart;

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

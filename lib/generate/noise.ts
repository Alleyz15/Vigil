import type { GeoPoint } from "@/lib/epcis";
import type { Rng } from "./rng";

/**
 * Environmental noise: what a real fleet's honest data looks like.
 *
 * WHY THIS EXISTS. Experiment 3 reported 0% false positives across 240 legs,
 * and that number was a floor rather than a rate: the clean timelines had
 * bounded noise by construction — six to eighteen metres of GPS accuracy,
 * eight to ninety seconds of upload latency, a battery that declined on rails —
 * so nothing in them came anywhere near a rule. `0%` measured "our clean data
 * does not trip our rules", which is a statement about the generator.
 *
 * THE RULE THIS MODULE LIVES UNDER (CLAUDE.md rule 2b). Parameters are drawn
 * from distributions that STRADDLE the rules, never from bands chosen to sit
 * under them. A basement fix lands at sixty metres sometimes — precise enough
 * that the location rules stay evaluable and can fire on a genuine drift — and
 * at two hundred and fifty metres other times, vague enough that they honestly
 * report `not_evaluated`. That crossing is where the false positives come from.
 * Rigging it away reproduces the exact problem this module exists to fix, and
 * is worse than the original because it looks measured.
 *
 * So every parameter below carries either a CITATION or the literal word
 * ASSUMPTION, and it changes only when the claim about the world is wrong —
 * never because of what it does to a number downstream. This module imports no
 * threshold and names none; `lib/purity.test.ts` enforces both.
 *
 * Full parameter table, with sources, in docs/DATASET.md.
 */

/* -------------------------------------------------------------------------- */
/* Levels                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A noise level is a claim about a fleet, not a knob.
 *
 * Level 0 is the control and MUST draw no randomness at all, so a level-0 run
 * is byte-identical to the dataset every existing test and scenario
 * expectation was written against. `planShipmentNoise` returns `undefined`
 * there and every call site short-circuits.
 */
export type NoiseLevel = 0 | 1 | 2 | 3;

export const NOISE_LEVELS: readonly NoiseLevel[] = [0, 1, 2, 3];

/** Where a scan happened, as far as the sky is concerned. */
export type Sky = "open" | "urban_canyon" | "indoor" | "underground";

/** A closed range, inclusive. */
type Range = readonly [number, number];

export type NoiseProfile = {
  level: NoiseLevel;
  name: string;
  /** One line, for the experiment tables and DATASET.md. */
  description: string;

  /**
   * How the fleet's scans are distributed across sky conditions. Two
   * distributions, because a depot yard and a residential delivery are not the
   * same environment. Weights need not sum to 1; they are normalised.
   */
  sky: {
    atAddress: Record<Sky, number>;
    atDepot: Record<Sky, number>;
  };

  /** Reported horizontal accuracy, in metres, by sky condition. */
  accuracyMeters: Record<Sky, Range>;

  network: {
    /** Ordinary upload latency, seconds, when the handset has service. */
    latencySeconds: Range;
    /** Share of scans taken with no usable uplink, which queue and upload late. */
    queuedShare: number;
    /** How long a queued scan waits before it uploads, in minutes. */
    queuedMinutes: Range;
  };

  clock: {
    /** Days since the handset last completed a network time sync. */
    offlineDays: Range;
    /** Free-running quartz drift, seconds per day. */
    driftSecondsPerDay: Range;
  };

  /** Delay between photographing at the door and the scan uploading, seconds. */
  photoDelaySeconds: Range;

  /** Per-shipment episodes. Probabilities. */
  episodes: {
    missedScan: number;
    recipientAbsent: number;
    addressCorrection: number;
    chargedMidShift: number;
    handsetSwap: number;
    /** Parcel registry still carries an old recipient channel. ASSUMPTION. */
    staleRecipientChannel: number;
    /** Play Integrity temporarily returns only BASIC for an enrolled device. ASSUMPTION. */
    attestationDegraded: number;
  };

  /** Percentage points a mid-shift charge puts back. */
  chargeGainPercentPoints: Range;
};

/**
 * The four levels.
 *
 * SOURCES, in full, are in docs/DATASET.md. In brief:
 *
 * - Open-sky smartphone accuracy 7-13 m: Merry & Bettinger 2019, PLOS ONE
 *   14(7):e0219890, an iPhone 6 measured against surveyed points in an urban
 *   setting across two seasons and two times of day.
 * - Urban canyon 15-50 m and beyond: the multipath/NLOS literature reports
 *   smartphone errors of tens of metres in built-up streets, exceeding 50 m
 *   where the sky view is narrow.
 * - Indoor and underground: with GNSS blocked the handset falls back to WiFi
 *   and cell, and reported accuracy degrades from metres to hundreds of metres.
 * - Quartz drift 1-5 s/day free-running: consumer-device timekeeping without a
 *   completed NTP or network time sync.
 * - First-attempt delivery failure 8-20% globally, up to ~30% in Europe; of
 *   those failures, 36% are "recipient not home" and 22% are address problems.
 *   The absent-recipient and address-correction rates below are that product.
 *
 * Everything else is an ASSUMPTION and is labelled as one, here and in
 * DATASET.md. No value below was chosen by looking at what it does to a rule.
 */
export const NOISE_PROFILES: Record<NoiseLevel, NoiseProfile> = {
  0: {
    level: 0,
    name: "pristine",
    description:
      "The control. No environmental noise at all: the dataset every scenario expectation was " +
      "written against. Draws no randomness, so a level-0 run is byte-identical to it.",
    // Unused at level 0 — nothing reads these, because nothing runs.
    sky: {
      atAddress: { open: 1, urban_canyon: 0, indoor: 0, underground: 0 },
      atDepot: { open: 1, urban_canyon: 0, indoor: 0, underground: 0 },
    },
    accuracyMeters: {
      open: [6, 18],
      urban_canyon: [6, 18],
      indoor: [6, 18],
      underground: [6, 18],
    },
    network: { latencySeconds: [8, 90], queuedShare: 0, queuedMinutes: [0, 0] },
    clock: { offlineDays: [0, 0], driftSecondsPerDay: [0, 0] },
    photoDelaySeconds: [10, 120],
    episodes: {
      missedScan: 0,
      recipientAbsent: 0,
      addressCorrection: 0,
      chargedMidShift: 0,
      handsetSwap: 0,
      staleRecipientChannel: 0,
      attestationDegraded: 0,
    },
    chargeGainPercentPoints: [0, 0],
  },

  1: {
    level: 1,
    name: "good",
    description:
      "A suburban round on a clear day. Mostly open sky, the occasional apartment lobby, a " +
      "handset that syncs its clock most days, and a fleet that rarely misses a scan.",
    sky: {
      atAddress: { open: 0.78, urban_canyon: 0.16, indoor: 0.055, underground: 0.005 },
      atDepot: { open: 0.94, urban_canyon: 0.0, indoor: 0.06, underground: 0.0 },
    },
    accuracyMeters: {
      open: [4, 13],
      urban_canyon: [12, 45],
      indoor: [25, 90],
      underground: [60, 220],
    },
    network: { latencySeconds: [5, 120], queuedShare: 0.02, queuedMinutes: [2, 25] },
    clock: { offlineDays: [0, 6], driftSecondsPerDay: [1, 5] },
    photoDelaySeconds: [10, 240],
    episodes: {
      missedScan: 0.015,
      recipientAbsent: 0.015,
      addressCorrection: 0.009,
      chargedMidShift: 0.05,
      handsetSwap: 0.01,
      // ASSUMPTION: 0.3% of parcels retain an old contact channel.
      staleRecipientChannel: 0.003,
      // ASSUMPTION: 0.5% of otherwise valid devices temporarily lose DEVICE.
      attestationDegraded: 0.005,
    },
    chargeGainPercentPoints: [15, 45],
  },

  2: {
    level: 2,
    name: "urban",
    description:
      "An ordinary Klang Valley round. Tower blocks narrow the sky view, a third of deliveries " +
      "end in a lobby or a basement carpark, uplink drops underground and the scans queue, and " +
      "the hub misses a scan often enough to notice.",
    sky: {
      atAddress: { open: 0.5, urban_canyon: 0.28, indoor: 0.15, underground: 0.07 },
      atDepot: { open: 0.84, urban_canyon: 0.02, indoor: 0.12, underground: 0.02 },
    },
    accuracyMeters: {
      open: [4, 15],
      urban_canyon: [15, 60],
      indoor: [30, 130],
      underground: [70, 320],
    },
    network: { latencySeconds: [5, 180], queuedShare: 0.07, queuedMinutes: [3, 55] },
    clock: { offlineDays: [0, 21], driftSecondsPerDay: [1, 5] },
    photoDelaySeconds: [15, 540],
    episodes: {
      missedScan: 0.05,
      recipientAbsent: 0.029,
      addressCorrection: 0.018,
      chargedMidShift: 0.12,
      handsetSwap: 0.03,
      // ASSUMPTION: 1% stale channels in an ordinary mixed-quality fleet.
      staleRecipientChannel: 0.01,
      // ASSUMPTION: 2% transient assurance downgrade.
      attestationDegraded: 0.02,
    },
    chargeGainPercentPoints: [15, 55],
  },

  3: {
    level: 3,
    name: "adverse",
    description:
      "A bad day in a dense CBD. Deep basements, an overloaded hub batching its uploads, " +
      "handsets that have not seen a time sync in weeks, and a courier working off a " +
      "replacement device.",
    sky: {
      atAddress: { open: 0.3, urban_canyon: 0.33, indoor: 0.22, underground: 0.15 },
      atDepot: { open: 0.7, urban_canyon: 0.06, indoor: 0.2, underground: 0.04 },
    },
    accuracyMeters: {
      open: [5, 20],
      urban_canyon: [20, 80],
      indoor: [40, 180],
      underground: [90, 450],
    },
    network: { latencySeconds: [5, 300], queuedShare: 0.14, queuedMinutes: [5, 110] },
    clock: { offlineDays: [0, 45], driftSecondsPerDay: [1, 5] },
    photoDelaySeconds: [20, 1200],
    episodes: {
      missedScan: 0.11,
      recipientAbsent: 0.108,
      addressCorrection: 0.066,
      chargedMidShift: 0.22,
      handsetSwap: 0.07,
      // ASSUMPTION: 3% stale channels during adverse operations.
      staleRecipientChannel: 0.03,
      // ASSUMPTION: 5% transient assurance downgrade.
      attestationDegraded: 0.05,
    },
    chargeGainPercentPoints: [15, 60],
  },
};

export function noiseProfile(level: NoiseLevel): NoiseProfile {
  return NOISE_PROFILES[level];
}

/** Parse a level from a CLI argument or an env var. Throws rather than guessing. */
export function parseNoiseLevel(value: string | number): NoiseLevel {
  const n = Number(value);
  if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  throw new Error(`noise level must be 0, 1, 2 or 3; got ${JSON.stringify(value)}`);
}

/* -------------------------------------------------------------------------- */
/* Per-shipment episodes                                                      */
/* -------------------------------------------------------------------------- */

/** The legs a missed scan may remove. */
export type SkippableLeg =
  | "sortation"
  | "linehaul_departure"
  | "linehaul_arrival"
  | "out_for_delivery";

/**
 * DRAWN UNIFORMLY, on purpose.
 *
 * Traced against `lib/engine/custody.ts` before this module was written, only
 * ONE of these four gaps produces an impermissible transition: without the
 * departure scan, the parcel reports `arriving` straight out of `in_progress`,
 * which the custody table does not permit. The other three are all legitimate
 * successor steps for the disposition they would follow.
 *
 * So H1's false-positive rate is a function of WHICH scan a fleet misses, and
 * that must fall out of the world model rather than be dialled in — in either
 * direction. Preferring the departure leg would manufacture H1; avoiding it
 * would hide H1. Uniform is the only honest choice. See CLAUDE.md session 10.
 */
export const SKIPPABLE_LEGS: readonly SkippableLeg[] = [
  "sortation",
  "linehaul_departure",
  "linehaul_arrival",
  "out_for_delivery",
];

export type AddressCorrection = {
  /**
   * How far the real address is from the one on the parcel record.
   *
   * "nearby" is a wrong unit number or a mis-geocoded street — the parcel stays
   * on the same round. "elsewhere" is a customer redirecting to an office or a
   * relative. The 70/30 split is an ASSUMPTION and is the parameter this result
   * is most sensitive to; it is stated as such in DATASET.md.
   */
  kind: "nearby" | "elsewhere";
  /** Index offset into the world's address list, so the new address is a real one. */
  addressOffset: number;
};

export type Episodes = {
  /** A scan the fleet never submitted. */
  missedLeg?: SkippableLeg;
  /** The recipient was out: a failed attempt, then a redelivery the next day. */
  redelivery: boolean;
  /** The parcel record is stale; the delivery happened somewhere else. */
  addressCorrection?: AddressCorrection;
  /** The courier charged the handset partway through the round. */
  chargedMidShift: boolean;
  /** The courier picked up a replacement handset partway through the round. */
  handsetSwap: boolean;
  /** OTP reaches the recipient's current channel while the parcel record is stale. */
  staleRecipientChannel: boolean;
  /** Live attestation falls from DEVICE to BASIC without a hard integrity failure. */
  attestationDegraded: boolean;
  /** Percentage points a mid-shift charge put back. */
  chargeGainPercentPoints: number;
};

export type ShipmentNoise = {
  profile: NoiseProfile;
  episodes: Episodes;
  /**
   * A handset's clock offset from true time, in seconds. Positive means the
   * device runs fast, so the eventTime it authors is ahead of reality.
   *
   * STABLE PER HANDSET, because it is a property of that quartz crystal. A
   * fresh draw per leg would be a random wobble, and a wobble is the shape of
   * tampering rather than of drift — the same mistake the battery model made in
   * session 6. Constant-per-device also means the offset CANCELS between two
   * legs from the same handset, so ordinary drift cannot inflate an implied
   * speed. Only a handset swap can.
   */
  clockOffsetSeconds: (deviceId: string) => number;
};

/**
 * Plan one shipment's noise.
 *
 * Returns `undefined` at level 0 WITHOUT DRAWING, which is what keeps a level-0
 * run byte-identical to the pre-noise dataset.
 */
export function planShipmentNoise(rng: Rng, level: NoiseLevel): ShipmentNoise | undefined {
  if (level === 0) return undefined;

  const profile = NOISE_PROFILES[level];
  const draw = rng.derive("noise");

  const episodes: Episodes = {
    missedLeg: draw.chance(profile.episodes.missedScan) ? draw.pick(SKIPPABLE_LEGS) : undefined,
    redelivery: draw.chance(profile.episodes.recipientAbsent),
    addressCorrection: draw.chance(profile.episodes.addressCorrection)
      ? {
          kind: draw.chance(0.7) ? "nearby" : "elsewhere",
          // 1..11 so the corrected address is a different real address in the
          // world, with its own cell and its own access point — which is what
          // makes this an I10/I11 case and not an I1 one. A courier standing at
          // the real address sees the real address's radio environment.
          addressOffset: draw.int(1, 11),
        }
      : undefined,
    chargedMidShift: draw.chance(profile.episodes.chargedMidShift),
    handsetSwap: draw.chance(profile.episodes.handsetSwap),
    staleRecipientChannel: draw.chance(profile.episodes.staleRecipientChannel),
    attestationDegraded: draw.chance(profile.episodes.attestationDegraded),
    chargeGainPercentPoints: Math.round(range(draw, profile.chargeGainPercentPoints)),
  };

  const offsets = new Map<string, number>();
  const clockOffsetSeconds = (deviceId: string): number => {
    const cached = offsets.get(deviceId);
    if (cached !== undefined) return cached;
    const device = draw.derive(`clock::${deviceId}`);
    const days = range(device, profile.clock.offlineDays);
    const rate = range(device, profile.clock.driftSecondsPerDay);
    const sign = device.chance(0.5) ? 1 : -1;
    const offset = Math.round(sign * days * rate);
    offsets.set(deviceId, offset);
    return offset;
  };

  return { profile, episodes, clockOffsetSeconds };
}

/* -------------------------------------------------------------------------- */
/* Per-event environment                                                      */
/* -------------------------------------------------------------------------- */

export type EventNoise = {
  sky: Sky;
  /** What the handset REPORTS as its horizontal accuracy. */
  accuracyMeters: number;
  /** How far the fix ACTUALLY is from the truth, and in which direction. */
  errorMeters: number;
  errorBearingRadians: number;
  /** Seconds between the scan and the server receiving it. */
  uploadLatencySeconds: number;
  /** Seconds between photographing at the door and the scan. */
  photoDelaySeconds: number;
  /** Underground, there is no serving cell and no access point to see. */
  omitCell: boolean;
  omitWifi: boolean;
};

/**
 * Draw one event's environment.
 *
 * THE REPORTED ACCURACY AND THE ACTUAL ERROR ARE DRAWN SEPARATELY, and that is
 * the whole point of the model. A receiver's accuracy figure is a confidence
 * radius, not a measurement of its own error: the true error is a draw whose
 * scale that figure sets, and it lands outside the circle about a third of the
 * time. So a fix can be precise-looking and wrong — which is the case the
 * location rules are asked to judge, and the case the old bounded generator
 * could not produce.
 */
export function drawEventNoise(
  rng: Rng,
  noise: ShipmentNoise,
  where: { atAddress: boolean },
): EventNoise {
  const { profile } = noise;
  const draw = rng.derive("env");

  const sky = pickWeighted(draw, where.atAddress ? profile.sky.atAddress : profile.sky.atDepot);
  const accuracyMeters = Math.round(range(draw, profile.accuracyMeters[sky]));

  // Rayleigh, scaled so the reported accuracy is the 68th percentile of the
  // true error — the ordinary reading of a GNSS accuracy figure. The tail is
  // real: about one fix in twenty is more than twice its stated accuracy out.
  //
  // The 0.999 clamp is a NUMERICAL guard against an unbounded tail, not a
  // ceiling chosen to stay under anything. At the widest band it bounds the
  // error near 1.1 km, which is well inside what a fix a receiver still
  // reports can be wrong by.
  const sigma = accuracyMeters / 1.5096;
  const u = Math.min(draw.next(), 0.999);
  const errorMeters = sigma * Math.sqrt(-2 * Math.log(1 - u));

  const queued = draw.chance(profile.network.queuedShare);
  const uploadLatencySeconds = queued
    ? range(draw, profile.network.queuedMinutes) * 60
    : range(draw, profile.network.latencySeconds);

  return {
    sky,
    accuracyMeters,
    errorMeters,
    errorBearingRadians: draw.float(0, Math.PI * 2),
    uploadLatencySeconds: Math.round(uploadLatencySeconds),
    photoDelaySeconds: Math.round(range(draw, profile.photoDelaySeconds)),
    // Underground there is nothing to observe. Indoors the serving cell usually
    // survives; the access points the registry knows about often do not.
    omitCell: sky === "underground",
    omitWifi: sky === "underground" || (sky === "indoor" && draw.chance(0.5)),
  };
}

/** Apply a drawn position error to a point. */
export function displace(point: GeoPoint, noise: EventNoise): GeoPoint {
  const north = Math.sin(noise.errorBearingRadians) * noise.errorMeters;
  const east = Math.cos(noise.errorBearingRadians) * noise.errorMeters;
  const latitude = point.latitude + north / 111_320;
  const longitude =
    point.longitude + east / (111_320 * Math.cos((point.latitude * Math.PI) / 180));
  return { latitude, longitude };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function range(rng: Rng, [min, max]: Range): number {
  return min === max ? min : rng.float(min, max);
}

function pickWeighted<K extends string>(rng: Rng, weights: Record<K, number>): K {
  const entries = Object.entries(weights) as [K, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let cursor = rng.float(0, total);
  for (const [key, weight] of entries) {
    cursor -= weight;
    if (cursor <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

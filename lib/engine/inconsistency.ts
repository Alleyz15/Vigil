import type { BizStep } from "@/lib/epcis";
import { distanceMeters, impliedSpeedKmh, minutesBetween } from "./geo";
import { matchBand } from "./thresholds";
import type { EngineInput, Evidence, RuleResult } from "./types";

/**
 * I1-I14: cross-signal contradiction scoring.
 *
 * Every rule here is a pure function of EngineInput. Every one of them asks
 * "do two independent signals disagree?", never "is this signal true?" —
 * because any single signal is forgeable and none of them can be checked alone.
 *
 * THREE STATES, NOT TWO. `not_evaluated` means the inputs were not there.
 * It is never a synonym for `clear`: a courier in a tunnel loses signals, and
 * scoring that as clean makes S6 indistinguishable from S1. See CLAUDE.md.
 */

const ev = (field: string, value: unknown): Evidence => ({ field, value });

const triggered = (
  id: string,
  points: number,
  label: string,
  evidence: Evidence[],
): RuleResult => ({ status: "triggered", flag: { id, points, label, evidence } });

const skip = (reason: string): RuleResult => ({ status: "not_evaluated", reason });
const clear: RuleResult = { status: "clear" };

/**
 * The business steps at which a proof of delivery is expected to exist and the
 * scan is expected to be at the recipient's address.
 *
 * EVERY RULE THAT APPLIES TO ONLY SOME bizSteps MUST STATE ITS GATE.
 * Ungated, I10/I11 and I12 would fire on every sortation and line-haul scan in
 * the S0 baseline — a depot scan is legitimately 300 km from the recipient and
 * legitimately has no signature — which would bury the "we do not over-flag"
 * claim under thousands of false positives. See CLAUDE.md.
 */
const DELIVERY_STEPS: readonly BizStep[] = [
  "urn:epcglobal:cbv:bizstep:delivering",
  "urn:epcglobal:cbv:bizstep:accepting",
];

export function isDeliveryEvent(bizStep: BizStep | undefined): boolean {
  return bizStep !== undefined && DELIVERY_STEPS.includes(bizStep);
}

/**
 * Whether a GPS fix is precise enough to contradict anything.
 * A fix reporting 200 m of uncertainty cannot establish that the device was
 * somewhere it should not have been.
 */
function fixIsUsable(input: EngineInput): boolean {
  const accuracy = input.sensor?.gps?.point.accuracyMeters;
  return accuracy === undefined || accuracy <= input.thresholds.gps.unusableAccuracyMeters;
}

/**
 * I1 - the positioning channels contradict each other.
 *
 * GPS is trivially spoofed. The serving cell's location is not the courier's to
 * choose, and neither are the WiFi APs within range. Making all three agree at a
 * location you are not at is a materially harder problem than editing one number.
 */
export function i1PositionConflict(input: EngineInput): RuleResult {
  const gps = input.sensor?.gps;
  if (!gps) return skip("no GPS fix on the event");
  if (!fixIsUsable(input)) return skip("GPS fix too imprecise to contradict anything");

  const cellSite = input.referenceSites?.cell;
  const wifiSites = input.referenceSites?.wifi ?? [];
  if (!cellSite && wifiSites.length === 0) {
    return skip("no independently-located cell or WiFi observation to compare against");
  }

  if (cellSite) {
    const gap = distanceMeters(gps.point, cellSite.point);
    if (gap > input.thresholds.gps.maxCellDisagreementMeters) {
      return triggered(
        "I1",
        input.thresholds.points.positionConflict,
        "The reported GPS position is far outside the range of the mobile tower the device was connected to.",
        [
          ev("sensor.gps.point", gps.point),
          ev("referenceSites.cell.id", cellSite.id),
          ev("referenceSites.cell.point", cellSite.point),
          ev("computed.distanceMeters", Math.round(gap)),
        ],
      );
    }
  }

  for (const site of wifiSites) {
    const gap = distanceMeters(gps.point, site.point);
    if (gap > input.thresholds.gps.maxWifiDisagreementMeters) {
      return triggered(
        "I1",
        input.thresholds.points.positionConflict,
        "The reported GPS position is nowhere near a WiFi network the device could see.",
        [
          ev("sensor.gps.point", gps.point),
          ev("referenceSites.wifi.id", site.id),
          ev("referenceSites.wifi.point", site.point),
          ev("computed.distanceMeters", Math.round(gap)),
        ],
      );
    }
  }

  return clear;
}

/**
 * I2 - the device claims to have moved while its accelerometer says it did not.
 *
 * Spoofing a position is easy; spoofing the physics of getting there is not.
 * A handset that travelled 400 m registered the vibration of doing so.
 */
export function i2MotionConflict(input: EngineInput): RuleResult {
  const motion = input.sensor?.motion;
  if (!motion) return skip("no accelerometer summary on the event");

  if (motion.meanAbsDeviationMs2 >= input.thresholds.motion.stationaryMs2) {
    // The device was moving. Whatever else is wrong, these two agree.
    return clear;
  }

  const gps = input.sensor?.gps;

  // Preferred source: the device's own GPS-derived speed over the motion window.
  if (gps?.speedMps !== undefined) {
    const impliedMeters = gps.speedMps * motion.windowSeconds;
    if (impliedMeters > input.thresholds.motion.movedMeters) {
      return triggered(
        "I2",
        input.thresholds.points.motionConflict,
        "The location data says the device was moving, but its motion sensor says it was sitting still.",
        [
          ev("sensor.motion.meanAbsDeviationMs2", motion.meanAbsDeviationMs2),
          ev("sensor.gps.speedMps", gps.speedMps),
          ev("computed.impliedMeters", Math.round(impliedMeters)),
        ],
      );
    }
    return clear;
  }

  // Fallback: displacement since the previous scan.
  const previousPoint = input.previous?.point;
  if (!previousPoint || !gps) {
    return skip("no GPS speed and no previous position to measure movement against");
  }

  const moved = distanceMeters(previousPoint, gps.point);
  if (moved > input.thresholds.motion.movedMeters) {
    return triggered(
      "I2",
      input.thresholds.points.motionConflict,
      "The device reports a new location since the last scan, but its motion sensor recorded no movement.",
      [
        ev("sensor.motion.meanAbsDeviationMs2", motion.meanAbsDeviationMs2),
        ev("previous.point", previousPoint),
        ev("sensor.gps.point", gps.point),
        ev("computed.movedMeters", Math.round(moved)),
      ],
    );
  }

  return clear;
}

/** I3 - getting from the previous scan to this one would have been physically impossible. */
export function i3ImpossibleSpeed(input: EngineInput): RuleResult {
  const previous = input.previous;
  const gps = input.sensor?.gps;

  if (!previous?.point) return skip("no previous event position");
  if (!gps) return skip("no GPS fix on the event");

  const speed = impliedSpeedKmh(
    { point: previous.point, at: previous.eventTime },
    { point: gps.point, at: input.event.eventTime },
  );
  if (speed === undefined) {
    return skip("previous and current timestamps do not form a positive interval");
  }

  if (speed > input.thresholds.maxImpliedSpeedKmh) {
    return triggered(
      "I3",
      input.thresholds.points.impossibleSpeed,
      "Travelling from the previous scan to this one in the time recorded is not physically possible.",
      [
        ev("previous.point", previous.point),
        ev("previous.eventTime", previous.eventTime),
        ev("sensor.gps.point", gps.point),
        ev("event.eventTime", input.event.eventTime),
        ev("computed.impliedSpeedKmh", Math.round(speed)),
      ],
    );
  }

  return clear;
}

/**
 * I4 / I5 - the device clock and the server clock disagree.
 *
 * One tiered rule, not two: a 45-minute divergence scores 30, never 45. The
 * bands are a table in thresholds.ts so experiment 6 can move a band edge
 * without touching this function.
 */
export function i4i5ClockDivergence(input: EngineInput): RuleResult {
  const recordTime = input.event.recordTime;
  if (!recordTime) return skip("recordTime not stamped");

  const minutes = minutesBetween(input.event.eventTime, recordTime);
  if (minutes === undefined) return skip("timestamps are not parsable");

  const band = matchBand(input.thresholds.clockDivergenceBands, minutes);
  if (!band) return clear;

  const label =
    band.id === "I4"
      ? "The time on the courier's device is far out of step with when the server received the scan. The timestamp may have been altered."
      : "The courier's device clock and the server clock do not agree.";

  return triggered(band.id, band.points, label, [
    ev("event.eventTime", input.event.eventTime),
    ev("event.recordTime", recordTime),
    ev("computed.divergenceMinutes", Math.round(minutes)),
  ]);
}

/** I6 - the scan came from a device this courier is not bound to. */
export function i6UnboundDevice(input: EngineInput): RuleResult {
  const scanningDevice = input.sensor?.deviceId;
  const boundDevice = input.courier?.boundDeviceId;

  if (!scanningDevice) return skip("event did not report a device id");
  if (!boundDevice) return skip("courier has no bound device on file");

  if (scanningDevice !== boundDevice) {
    return triggered(
      "I6",
      input.thresholds.points.unboundDevice,
      "This scan came from a handset that is not the one issued to this courier.",
      [ev("sensor.deviceId", scanningDevice), ev("courier.boundDeviceId", boundDevice)],
    );
  }

  return clear;
}

/** I7 - the operating system reported that the location came from a mock provider. */
export function i7MockLocation(input: EngineInput): RuleResult {
  const gps = input.sensor?.gps;
  if (!gps) return skip("no GPS fix on the event");

  if (gps.mockLocationProvider) {
    return triggered(
      "I7",
      input.thresholds.points.mockLocation,
      "The device reported that its location was supplied by a fake location app.",
      [ev("sensor.gps.mockLocationProvider", true), ev("sensor.gps.point", gps.point)],
    );
  }

  return clear;
}

/**
 * I8 - device integrity attestation failed.
 *
 * `unevaluated` is not a pass. An attestation that could not be checked has told
 * us nothing, and treating silence as approval is how attestation gets defeated.
 */
export function i8IntegrityFailed(input: EngineInput): RuleResult {
  const integrity = input.sensor?.integrity;
  if (!integrity) return skip("no device integrity attestation on the event");
  if (integrity.verdict === "unevaluated") return skip("attestation was not evaluated");

  if (integrity.verdict === "failed" || integrity.rootDetected || integrity.appTampered) {
    return triggered(
      "I8",
      input.thresholds.points.integrityFailed,
      "The courier's device failed its security check. It may be modified or running tampered software.",
      [
        ev("sensor.integrity.verdict", integrity.verdict),
        ev("sensor.integrity.rootDetected", integrity.rootDetected),
        ev("sensor.integrity.appTampered", integrity.appTampered),
        ev("sensor.integrity.attestationSource", integrity.attestationSource),
      ],
    );
  }

  return clear;
}

/** I9 - the delivery photo was not taken when the scan says it was. */
export function i9PhotoTimeMismatch(input: EngineInput): RuleResult {
  const captureTime = input.sensor?.pod?.photoExifCaptureTime;
  if (!captureTime) return skip("no photo capture time on the event");

  const minutes = minutesBetween(captureTime, input.event.eventTime);
  if (minutes === undefined) return skip("photo capture time is not parsable");

  if (minutes > input.thresholds.maxPhotoAgeMinutes) {
    return triggered(
      "I9",
      input.thresholds.points.photoTimeMismatch,
      "The delivery photo was taken at a noticeably different time from the scan. It may not be a photo of this delivery.",
      [
        ev("sensor.pod.photoExifCaptureTime", captureTime),
        ev("event.eventTime", input.event.eventTime),
        ev("computed.gapMinutes", Math.round(minutes)),
      ],
    );
  }

  return clear;
}

/**
 * I10 / I11 - the scan happened away from the recipient's address.
 *
 * GATED to delivery-type events. A depot scan is legitimately far from the
 * recipient and must not be scored for it.
 *
 * One tiered rule: >2 km scores 40, not 40 + 20.
 */
export function i10i11DeliveryDistance(input: EngineInput): RuleResult {
  if (!isDeliveryEvent(input.event.bizStep)) {
    return skip("not a delivery event; the scan is not expected to be at the recipient address");
  }

  const gps = input.sensor?.gps;
  const recipientPoint = input.parcel?.recipientPoint;
  if (!gps) return skip("no GPS fix on the event");
  if (!recipientPoint) return skip("no recipient coordinates on file for this parcel");
  if (!fixIsUsable(input)) return skip("GPS fix too imprecise to establish a distance");

  const metres = distanceMeters(gps.point, recipientPoint);
  const band = matchBand(input.thresholds.deliveryDistanceBands, metres);
  if (!band) return clear;

  const label =
    band.id === "I10"
      ? "The delivery was scanned a long way from the recipient's address."
      : "The delivery was scanned away from the recipient's address.";

  return triggered(band.id, band.points, label, [
    ev("sensor.gps.point", gps.point),
    ev("parcel.recipientPoint", recipientPoint),
    ev("computed.distanceMeters", Math.round(metres)),
  ]);
}

/**
 * I12 - proof-of-delivery artefacts are missing.
 *
 * GATED to delivery-type events, for the reason given at DELIVERY_STEPS.
 * Scores per missing artefact, reported as one flag so the operator reads one
 * line rather than three.
 */
export function i12MissingPod(input: EngineInput): RuleResult {
  if (!isDeliveryEvent(input.event.bizStep)) {
    return skip("not a delivery event; no proof of delivery is expected");
  }

  const pod = input.sensor?.pod;
  const missing: Evidence[] = [];

  if (!pod?.photoSha256) missing.push(ev("sensor.pod.photoSha256", null));
  if (pod?.otpVerified !== true) missing.push(ev("sensor.pod.otpVerified", pod?.otpVerified ?? null));
  if (!pod?.signatureSha256) missing.push(ev("sensor.pod.signatureSha256", null));

  if (missing.length === 0) return clear;

  const names = missing.map((m) => m.field.split(".").pop());
  return triggered(
    "I12",
    input.thresholds.points.missingPodArtefact * missing.length,
    `This delivery was recorded without ${missing.length} of the 3 required pieces of proof.`,
    [...missing, ev("computed.missingArtefacts", names)],
  );
}

/**
 * I13 - the scan fell outside the courier's permitted working hours.
 *
 * Scores rather than aborts: working outside your shift is a policy breach worth
 * an operator's attention, not grounds for voiding the handoff. A revoked
 * mandate is grounds for that, and it is H3.
 */
export function i13OutsideTimeWindow(input: EngineInput): RuleResult {
  const windows = input.mandate?.validity.timeWindows;
  if (!windows || windows.length === 0) return skip("mandate places no restriction on hours");

  const minutes = localMinutesOfDay(input.event.eventTime, input.event.eventTimeZoneOffset);
  if (minutes === undefined) return skip("event time is not parsable");

  const inAnyWindow = windows.some((w) =>
    withinWindow(minutes, toMinutes(w.start), toMinutes(w.end)),
  );
  if (inAnyWindow) return clear;

  return triggered(
    "I13",
    input.thresholds.points.outsideTimeWindow,
    "This scan was made outside the hours the courier is authorised to work.",
    [
      ev("event.eventTime", input.event.eventTime),
      ev("event.eventTimeZoneOffset", input.event.eventTimeZoneOffset),
      ev("mandate.validity.timeWindows", windows),
      ev("computed.localTime", formatMinutes(minutes)),
    ],
  );
}

/**
 * I14 - battery use does not match the distance claimed.
 *
 * The weakest rule in the set, hence +10. A long drive with GPS, screen and
 * radio active costs measurable battery; a route that claims the distance but
 * not the energy is claiming a journey the handset did not take.
 */
export function i14BatteryMismatch(input: EngineInput): RuleResult {
  const battery = input.sensor?.battery;
  const previousBattery = input.previous?.batteryPercent;
  const previousPoint = input.previous?.point;
  const gps = input.sensor?.gps;

  if (!battery) return skip("no battery reading on the event");
  if (previousBattery === undefined) return skip("no previous battery reading");
  if (!previousPoint || !gps) return skip("no previous position to measure distance travelled");
  if (battery.charging) return skip("device was charging; drain tells us nothing");

  const km = distanceMeters(previousPoint, gps.point) / 1000;
  if (km < input.thresholds.battery.minDistanceKm) {
    return skip("claimed distance too short to imply measurable battery use");
  }

  const drop = previousBattery - battery.levelPercent;
  if (drop < input.thresholds.battery.minDropPercentPoints) {
    return triggered(
      "I14",
      input.thresholds.points.batteryMismatch,
      "The device barely used any battery over a journey this long.",
      [
        ev("previous.batteryPercent", previousBattery),
        ev("sensor.battery.levelPercent", battery.levelPercent),
        ev("computed.distanceKm", Math.round(km)),
        ev("computed.dropPercentPoints", drop),
      ],
    );
  }

  return clear;
}

/* -------------------------------------------------------------------------- */
/* Local-time helpers for I13                                                 */
/* -------------------------------------------------------------------------- */

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Wall-clock minutes since local midnight, using the event's own declared offset. */
function localMinutesOfDay(iso: string, offset: string): number | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;

  const sign = offset.startsWith("-") ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  const shifted = new Date(ms + sign * (h * 60 + m) * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** Window containment. A window whose end is before its start crosses midnight. */
function withinWindow(minutes: number, start: number, end: number): boolean {
  if (start < end) return minutes >= start && minutes < end;
  // start >= end: wraps midnight (and start === end means the whole day).
  return minutes >= start || minutes < end;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One entry per rule function. `ids` lists the flag ids the rule can emit, so a
 * tiered rule reports both of its ids in the coverage count — there are 14
 * numbered checks in the spec and the operator's "n of 14" line must say 14.
 */
export type RuleEntry = {
  ids: string[];
  run: (input: EngineInput) => RuleResult;
};

export const INCONSISTENCY_RULES: readonly RuleEntry[] = [
  { ids: ["I1"], run: i1PositionConflict },
  { ids: ["I2"], run: i2MotionConflict },
  { ids: ["I3"], run: i3ImpossibleSpeed },
  { ids: ["I4", "I5"], run: i4i5ClockDivergence },
  { ids: ["I6"], run: i6UnboundDevice },
  { ids: ["I7"], run: i7MockLocation },
  { ids: ["I8"], run: i8IntegrityFailed },
  { ids: ["I9"], run: i9PhotoTimeMismatch },
  { ids: ["I10", "I11"], run: i10i11DeliveryDistance },
  { ids: ["I12"], run: i12MissingPod },
  { ids: ["I13"], run: i13OutsideTimeWindow },
  { ids: ["I14"], run: i14BatteryMismatch },
];

/** 14 — the denominator in the operator's "n of 14 checks evaluable" line. */
export const TOTAL_CHECKS = INCONSISTENCY_RULES.reduce((n, r) => n + r.ids.length, 0);

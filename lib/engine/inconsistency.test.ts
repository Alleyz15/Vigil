import { describe, expect, it } from "vitest";
import {
  INCONSISTENCY_RULES,
  TOTAL_CHECKS,
  i10i11DeliveryDistance,
  i12MissingPod,
  i13OutsideTimeWindow,
  i14BatteryMismatch,
  i15OtpProvenanceConflict,
  i16AttestationBelowEnrollment,
  i1PositionConflict,
  i2MotionConflict,
  i3ImpossibleSpeed,
  i4i5ClockDivergence,
  i6UnboundDevice,
  i7MockLocation,
  i8IntegrityFailed,
  i9PhotoTimeMismatch,
  isDeliveryEvent,
} from "./inconsistency";
import { DEFAULT_THRESHOLDS } from "./thresholds";
import {
  IPOH,
  KL_AMPANG,
  KL_AMPANG_DOORSTEP,
  KL_AMPANG_NEXT_BLOCK,
  SHAH_ALAM,
  makeEvent,
  makeInput,
  makeMandate,
} from "./fixtures";
import type { EngineInput, RuleResult } from "./types";
import type { VigilSignals } from "@/lib/epcis";

/** Assert a rule fired, and hand back the flag. */
function flagOf(result: RuleResult) {
  expect(result.status).toBe("triggered");
  if (result.status !== "triggered") throw new Error("unreachable");
  return result.flag;
}

function expectSkipped(result: RuleResult, match: RegExp) {
  expect(result.status).toBe("not_evaluated");
  if (result.status !== "not_evaluated") return;
  expect(result.reason).toMatch(match);
}

/** Replace the sensor bundle wholesale. */
const withSensor = (sensor: VigilSignals | undefined, over: Partial<EngineInput> = {}) =>
  makeInput({ sensor, ...over });

/** Patch one branch of the sensor bundle, keeping the rest of the clean fixture. */
function patchSensor(patch: Partial<VigilSignals>, over: Partial<EngineInput> = {}): EngineInput {
  const base = makeInput(over);
  return { ...base, sensor: { ...base.sensor, ...patch } };
}

describe("I1 - positioning channels contradict each other", () => {
  it("triggers when GPS is far outside the serving cell's range", () => {
    const input = patchSensor({
      gps: {
        point: { ...IPOH, accuracyMeters: 8 },
        fixTime: "2026-09-08T10:15:00+08:00",
        mockLocationProvider: false,
      },
    });

    const flag = flagOf(i1PositionConflict(input));
    expect(flag.id).toBe("I1");
    expect(flag.points).toBe(40);
    expect(flag.evidence).toContainEqual({ field: "referenceSites.cell.id", value: "502-12-4501-90210" });
  });

  it("triggers when GPS is far from a WiFi network the device could see", () => {
    // 3 km away: inside the 5 km cell tolerance, outside the 300 m WiFi tolerance.
    const input = patchSensor(
      {
        gps: {
          point: { latitude: 3.1865, longitude: 101.7123, accuracyMeters: 8 },
          fixTime: "2026-09-08T10:15:00+08:00",
          mockLocationProvider: false,
        },
      },
      { referenceSites: { wifi: [{ id: "a4:2b:8c:00:11:22", point: KL_AMPANG }] } },
    );

    const flag = flagOf(i1PositionConflict(input));
    expect(flag.evidence).toContainEqual({ field: "referenceSites.wifi.id", value: "a4:2b:8c:00:11:22" });
  });

  it("does not trigger on the near-miss: inside both tolerances", () => {
    expect(i1PositionConflict(makeInput()).status).toBe("clear");
  });

  it("does not evaluate when there are no reference sites - S6's absence path", () => {
    expectSkipped(i1PositionConflict(makeInput({ referenceSites: undefined })), /no independently-located/);
  });

  it("does not evaluate when there is no GPS fix at all", () => {
    expectSkipped(i1PositionConflict(patchSensor({ gps: undefined })), /no GPS fix/);
  });

  it("does not evaluate a fix too imprecise to contradict anything - the tunnel case", () => {
    const input = patchSensor({
      gps: {
        point: { ...IPOH, accuracyMeters: 400 },
        fixTime: "2026-09-08T10:15:00+08:00",
        mockLocationProvider: false,
      },
    });
    // The same coordinates that trigger at 8 m accuracy must NOT trigger at 400 m.
    expectSkipped(i1PositionConflict(input), /too imprecise/);
  });
});

describe("I2 - accelerometer says still, location says moving", () => {
  it("triggers on GPS speed while the device reads stationary", () => {
    const flag = flagOf(
      i2MotionConflict(
        patchSensor({
          motion: { windowSeconds: 60, meanAbsDeviationMs2: 0.01, maxAbsDeviationMs2: 0.03 },
          gps: {
            point: { ...KL_AMPANG_DOORSTEP, accuracyMeters: 8 },
            fixTime: "2026-09-08T10:15:00+08:00",
            speedMps: 12,
            mockLocationProvider: false,
          },
        }),
      ),
    );

    expect(flag.id).toBe("I2");
    expect(flag.points).toBe(40);
    expect(flag.evidence).toContainEqual({ field: "computed.impliedMeters", value: 720 });
  });

  it("triggers on displacement from the previous scan when no GPS speed is reported", () => {
    const flag = flagOf(
      i2MotionConflict(
        patchSensor({
          motion: { windowSeconds: 60, meanAbsDeviationMs2: 0.01, maxAbsDeviationMs2: 0.03 },
          gps: {
            point: { ...SHAH_ALAM, accuracyMeters: 8 },
            fixTime: "2026-09-08T10:15:00+08:00",
            mockLocationProvider: false,
          },
        }),
      ),
    );

    expect(flag.evidence).toContainEqual({ field: "previous.point", value: KL_AMPANG_NEXT_BLOCK });
  });

  it("does not trigger on the near-miss: still device, negligible implied movement", () => {
    const result = i2MotionConflict(
      patchSensor({
        motion: { windowSeconds: 60, meanAbsDeviationMs2: 0.01, maxAbsDeviationMs2: 0.03 },
        gps: {
          point: { ...KL_AMPANG_DOORSTEP, accuracyMeters: 8 },
          fixTime: "2026-09-08T10:15:00+08:00",
          speedMps: 0.2, // 12 m over the window, under the 15 m floor
          mockLocationProvider: false,
        },
      }),
    );
    expect(result.status).toBe("clear");
  });

  it("is clear when the device is still and barely moved since the last scan", () => {
    // Fallback path with no GPS speed: 89 m separates the two fixture points,
    // but a still device that has not moved is not a contradiction - it agrees.
    const result = i2MotionConflict(
      patchSensor({
        motion: { windowSeconds: 60, meanAbsDeviationMs2: 0.01, maxAbsDeviationMs2: 0.03 },
        gps: {
          point: { ...KL_AMPANG_NEXT_BLOCK, accuracyMeters: 8 },
          fixTime: "2026-09-08T10:15:00+08:00",
          mockLocationProvider: false,
        },
      }),
    );
    expect(result.status).toBe("clear");
  });

  it("is clear when the accelerometer agrees the device was moving", () => {
    expect(i2MotionConflict(makeInput()).status).toBe("clear");
  });

  it("does not evaluate without an accelerometer summary", () => {
    expectSkipped(i2MotionConflict(patchSensor({ motion: undefined })), /no accelerometer/);
  });

  it("does not evaluate when there is no previous position and no GPS speed - S6's absence path", () => {
    const input = patchSensor(
      {
        motion: { windowSeconds: 60, meanAbsDeviationMs2: 0.01, maxAbsDeviationMs2: 0.03 },
        gps: {
          point: { ...KL_AMPANG_DOORSTEP, accuracyMeters: 8 },
          fixTime: "2026-09-08T10:15:00+08:00",
          mockLocationProvider: false,
        },
      },
      { previous: undefined },
    );
    expectSkipped(i2MotionConflict(input), /no GPS speed and no previous position/);
  });
});

describe("I3 - physically impossible movement", () => {
  const thirtyMinutesFrom = (point: typeof IPOH) =>
    patchSensor({
      gps: { point: { ...point, accuracyMeters: 8 }, fixTime: "2026-09-08T10:15:00+08:00", mockLocationProvider: false },
    });

  it("triggers at 348 km/h - KL to Ipoh in half an hour", () => {
    const flag = flagOf(i3ImpossibleSpeed(thirtyMinutesFrom(IPOH)));

    expect(flag.id).toBe("I3");
    expect(flag.points).toBe(40);
    expect(flag.evidence).toContainEqual({ field: "computed.impliedSpeedKmh", value: 348 });
  });

  it("does not trigger on the near-miss: 119 km/h against a 120 km/h limit", () => {
    // 59.5 km in 30 minutes = 119 km/h.
    const input = patchSensor({
      gps: {
        point: { latitude: 3.6939, longitude: 101.7123, accuracyMeters: 8 },
        fixTime: "2026-09-08T10:15:00+08:00",
        mockLocationProvider: false,
      },
    });
    expect(i3ImpossibleSpeed(input).status).toBe("clear");
  });

  it("does not evaluate without a previous position - S6's absence path", () => {
    expectSkipped(i3ImpossibleSpeed(makeInput({ previous: undefined })), /no previous event position/);
  });

  it("does not evaluate without a GPS fix", () => {
    expectSkipped(i3ImpossibleSpeed(patchSensor({ gps: undefined })), /no GPS fix/);
  });

  it("does not manufacture an infinite speed from a zero-length interval", () => {
    const input = makeInput({
      previous: {
        eventTime: "2026-09-08T10:15:00+08:00", // identical to eventTime
        point: IPOH,
      },
    });
    expectSkipped(i3ImpossibleSpeed(input), /positive interval/);
  });

  it("does not manufacture a speed from an out-of-order interval", () => {
    const input = makeInput({
      previous: { eventTime: "2026-09-08T11:15:00+08:00", point: IPOH },
    });
    expectSkipped(i3ImpossibleSpeed(input), /positive interval/);
  });
});

describe("I4 / I5 - device clock vs server clock", () => {
  const withRecordTime = (recordTime: string) =>
    makeInput({ event: makeEvent({ eventTime: "2026-09-08T10:15:00+08:00", recordTime }) });

  it("triggers I4 when the device is 45 minutes ahead and scores 30", () => {
    const flag = flagOf(i4i5ClockDivergence(withRecordTime("2026-09-08T09:30:00+08:00")));

    expect(flag.id).toBe("I4");
    expect(flag.points).toBe(30);
    expect(flag.evidence).toContainEqual({ field: "computed.deviceAheadMinutes", value: 45 });
  });

  it("triggers I5 when the server receives a scan eight hours late and scores 10", () => {
    const flag = flagOf(i4i5ClockDivergence(withRecordTime("2026-09-08T18:15:00+08:00")));

    expect(flag.id).toBe("I5");
    expect(flag.points).toBe(10);
    expect(flag.evidence).toContainEqual({ field: "computed.uploadDelayMinutes", value: 480 });
  });

  it("does not treat a 45-minute queued upload as clock tampering", () => {
    expect(i4i5ClockDivergence(withRecordTime("2026-09-08T11:00:00+08:00")).status).toBe(
      "clear",
    );
  });

  it("does not trigger I4 when the device is 29 minutes ahead", () => {
    expect(i4i5ClockDivergence(withRecordTime("2026-09-08T09:46:00+08:00")).status).toBe(
      "clear",
    );
  });

  it("does not trigger I5 when the server delay is 479 minutes", () => {
    expect(i4i5ClockDivergence(withRecordTime("2026-09-08T18:14:00+08:00")).status).toBe(
      "clear",
    );
  });

  it("triggers each directional band exactly at its inclusive edge", () => {
    expect(flagOf(i4i5ClockDivergence(withRecordTime("2026-09-08T09:45:00+08:00"))).id).toBe(
      "I4",
    );
    expect(flagOf(i4i5ClockDivergence(withRecordTime("2026-09-08T18:15:00+08:00"))).id).toBe(
      "I5",
    );
  });

  it("does not evaluate when recordTime was never stamped", () => {
    const input = makeInput({ event: makeEvent({ recordTime: undefined }) });
    expectSkipped(i4i5ClockDivergence(input), /recordTime not stamped/);
  });

  it("does not evaluate unparsable timestamps", () => {
    const input = makeInput();
    (input.event as { recordTime?: string }).recordTime = "not-a-date";
    expectSkipped(i4i5ClockDivergence(input), /not parsable/);
  });
});

describe("I6 - unbound device", () => {
  it("triggers when the scanning handset is not the courier's", () => {
    const flag = flagOf(i6UnboundDevice(patchSensor({ deviceId: "HHT-9999" })));

    expect(flag.id).toBe("I6");
    expect(flag.points).toBe(25);
    expect(flag.evidence).toContainEqual({ field: "courier.boundDeviceId", value: "HHT-0042" });
  });

  it("does not trigger when the device matches", () => {
    expect(i6UnboundDevice(makeInput()).status).toBe("clear");
  });

  it("does not evaluate when the event reported no device id", () => {
    expectSkipped(i6UnboundDevice(patchSensor({ deviceId: undefined })), /did not report a device id/);
  });

  it("does not evaluate when the courier has no bound device on file", () => {
    const input = makeInput({ courier: { courierId: "CR-0042", boundDeviceId: null } });
    expectSkipped(i6UnboundDevice(input), /no bound device/);
  });
});

describe("I7 - mock location provider", () => {
  it("triggers when the OS reported a fake location app", () => {
    const flag = flagOf(
      i7MockLocation(
        patchSensor({
          gps: {
            point: { ...KL_AMPANG_DOORSTEP, accuracyMeters: 8 },
            fixTime: "2026-09-08T10:15:00+08:00",
            mockLocationProvider: true,
          },
        }),
      ),
    );

    expect(flag.id).toBe("I7");
    expect(flag.points).toBe(50);
  });

  it("does not trigger when the flag is false", () => {
    expect(i7MockLocation(makeInput()).status).toBe("clear");
  });

  it("does not evaluate without a GPS fix", () => {
    expectSkipped(i7MockLocation(patchSensor({ gps: undefined })), /no GPS fix/);
  });
});

describe("I8 - device integrity", () => {
  const integrity = (over: Partial<NonNullable<VigilSignals["integrity"]>>) =>
    patchSensor({
      integrity: {
        attestationSource: "mocked",
        verdict: "passed",
        rootDetected: false,
        appTampered: false,
        ...over,
      },
    });

  it("triggers on an explicit failed verdict", () => {
    const flag = flagOf(i8IntegrityFailed(integrity({ verdict: "failed" })));
    expect(flag.id).toBe("I8");
    expect(flag.points).toBe(50);
  });

  it("triggers on root detection even when the overall verdict passed", () => {
    expect(flagOf(i8IntegrityFailed(integrity({ rootDetected: true }))).id).toBe("I8");
  });

  it("triggers on app tampering even when the overall verdict passed", () => {
    expect(flagOf(i8IntegrityFailed(integrity({ appTampered: true }))).id).toBe("I8");
  });

  it("does not trigger on a clean attestation", () => {
    expect(i8IntegrityFailed(makeInput()).status).toBe("clear");
  });

  it("treats an unevaluated attestation as unknown, never as a pass", () => {
    expectSkipped(i8IntegrityFailed(integrity({ verdict: "unevaluated" })), /not evaluated/);
  });

  it("does not evaluate when no attestation was supplied", () => {
    expectSkipped(i8IntegrityFailed(patchSensor({ integrity: undefined })), /no device integrity/);
  });

  it("records which attestation source the verdict came from", () => {
    const flag = flagOf(i8IntegrityFailed(integrity({ verdict: "failed" })));
    expect(flag.evidence).toContainEqual({
      field: "sensor.integrity.attestationSource",
      value: "mocked",
    });
  });
});

describe("I9 - photo capture time", () => {
  const pod = (photoExifCaptureTime: string) =>
    patchSensor({
      pod: {
        photoSha256: "a".repeat(64),
        photoExifCaptureTime,
        otpVerified: true,
        signatureSha256: "b".repeat(64),
      },
    });

  it("triggers when the photo predates the scan by more than the allowance", () => {
    const flag = flagOf(i9PhotoTimeMismatch(pod("2026-09-08T09:30:00+08:00")));

    expect(flag.id).toBe("I9");
    expect(flag.points).toBe(25);
    expect(flag.evidence).toContainEqual({ field: "computed.gapMinutes", value: 45 });
  });

  it("does not trigger on the near-miss: 14 minutes against a 15 minute allowance", () => {
    expect(i9PhotoTimeMismatch(pod("2026-09-08T10:01:00+08:00")).status).toBe("clear");
  });

  it("does not evaluate an unparsable photo capture time", () => {
    expectSkipped(i9PhotoTimeMismatch(pod("not-a-date")), /not parsable/);
  });

  it("does not evaluate when the photo carried no EXIF capture time", () => {
    expectSkipped(i9PhotoTimeMismatch(patchSensor({ pod: { photoSha256: "a".repeat(64) } })), /no photo capture time/);
  });
});

describe("I10 / I11 - distance from the recipient address", () => {
  const scannedAt = (point: typeof KL_AMPANG) =>
    patchSensor({
      gps: { point: { ...point, accuracyMeters: 8 }, fixTime: "2026-09-08T10:15:00+08:00", mockLocationProvider: false },
    });

  it("triggers I10 at 23 km and scores 40, NOT 40 + 20", () => {
    const flag = flagOf(i10i11DeliveryDistance(scannedAt(SHAH_ALAM)));

    expect(flag.id).toBe("I10");
    expect(flag.points).toBe(40);
  });

  it("triggers I11 in the 200 m - 2 km band and scores 20", () => {
    const flag = flagOf(i10i11DeliveryDistance(scannedAt(KL_AMPANG_NEXT_BLOCK)));

    expect(flag.id).toBe("I11");
    expect(flag.points).toBe(20);
    expect(flag.evidence).toContainEqual({ field: "computed.distanceMeters", value: 234 });
  });

  it("does not trigger on the near-miss: 145 m, under the I11 band", () => {
    expect(i10i11DeliveryDistance(makeInput()).status).toBe("clear");
  });

  it("is NOT evaluated on a sortation scan, which is legitimately far from the recipient", () => {
    const input = makeInput({
      event: makeEvent({ bizStep: "urn:epcglobal:cbv:bizstep:storing" }),
      sensor: { gps: { point: { ...SHAH_ALAM, accuracyMeters: 8 }, fixTime: "2026-09-08T10:15:00+08:00", mockLocationProvider: false } },
    });
    expectSkipped(i10i11DeliveryDistance(input), /not a delivery event/);
  });

  it("does not evaluate when the parcel has no recipient coordinates", () => {
    expectSkipped(i10i11DeliveryDistance(makeInput({ parcel: { epc: "x" } })), /no recipient coordinates/);
  });

  it("does not evaluate a fix too imprecise to establish a distance", () => {
    const input = patchSensor({
      gps: { point: { ...SHAH_ALAM, accuracyMeters: 500 }, fixTime: "2026-09-08T10:15:00+08:00", mockLocationProvider: false },
    });
    expectSkipped(i10i11DeliveryDistance(input), /too imprecise/);
  });

  it("does not evaluate without a GPS fix", () => {
    expectSkipped(i10i11DeliveryDistance(patchSensor({ gps: undefined })), /no GPS fix/);
  });
});

describe("I12 - missing proof of delivery", () => {
  it("scores 15 per missing artefact and reports them in one flag", () => {
    const flag = flagOf(i12MissingPod(patchSensor({ pod: undefined })));

    expect(flag.id).toBe("I12");
    expect(flag.points).toBe(45);
    expect(flag.evidence).toContainEqual({
      field: "computed.missingArtefacts",
      value: ["photoSha256", "otpVerified", "signatureSha256"],
    });
  });

  it("scores 15 when exactly one artefact is missing", () => {
    const flag = flagOf(
      i12MissingPod(
        patchSensor({
          pod: { photoSha256: "a".repeat(64), otpVerified: true },
        }),
      ),
    );
    expect(flag.points).toBe(15);
  });

  it("treats an unverified OTP as missing, not as present", () => {
    const flag = flagOf(
      i12MissingPod(
        patchSensor({
          pod: { photoSha256: "a".repeat(64), otpVerified: false, signatureSha256: "b".repeat(64) },
        }),
      ),
    );
    expect(flag.points).toBe(15);
  });

  it("does not trigger when all three are present", () => {
    expect(i12MissingPod(makeInput()).status).toBe("clear");
  });

  it("is NOT evaluated on a line-haul scan, which never has a proof of delivery", () => {
    const input = makeInput({
      event: makeEvent({ bizStep: "urn:epcglobal:cbv:bizstep:departing" }),
      sensor: {},
    });
    expectSkipped(i12MissingPod(input), /not a delivery event/);
  });

  it("recognises accepting as a delivery step alongside delivering", () => {
    expect(isDeliveryEvent("urn:epcglobal:cbv:bizstep:accepting")).toBe(true);
    expect(isDeliveryEvent("urn:epcglobal:cbv:bizstep:departing")).toBe(false);
    expect(isDeliveryEvent(undefined)).toBe(false);
  });
});

describe("I13 - outside the permitted working hours", () => {
  const shift = (windows: { start: string; end: string }[], eventTime: string) =>
    makeInput({
      event: makeEvent({ eventTime }),
      mandate: makeMandate({
        validity: {
          notBefore: "2026-09-01T00:00:00+08:00",
          notAfter: "2026-12-31T23:59:59+08:00",
          timeWindows: windows,
        },
      }),
    });

  it("triggers on a scan outside the shift", () => {
    const flag = flagOf(
      i13OutsideTimeWindow(shift([{ start: "08:00", end: "18:00" }], "2026-09-08T22:30:00+08:00")),
    );

    expect(flag.id).toBe("I13");
    expect(flag.points).toBe(20);
    expect(flag.evidence).toContainEqual({ field: "computed.localTime", value: "22:30" });
  });

  it("does not trigger on the near-miss: one minute before the shift ends", () => {
    expect(
      i13OutsideTimeWindow(shift([{ start: "08:00", end: "18:00" }], "2026-09-08T17:59:00+08:00")).status,
    ).toBe("clear");
  });

  it("treats the window end as exclusive", () => {
    expect(
      i13OutsideTimeWindow(shift([{ start: "08:00", end: "18:00" }], "2026-09-08T18:00:00+08:00")).status,
    ).toBe("triggered");
  });

  it("handles a night shift that crosses midnight", () => {
    const nightShift = [{ start: "22:00", end: "06:00" }];
    expect(i13OutsideTimeWindow(shift(nightShift, "2026-09-08T23:30:00+08:00")).status).toBe("clear");
    expect(i13OutsideTimeWindow(shift(nightShift, "2026-09-08T02:30:00+08:00")).status).toBe("clear");
    expect(i13OutsideTimeWindow(shift(nightShift, "2026-09-08T12:00:00+08:00")).status).toBe("triggered");
  });

  it("accepts a scan inside any one of several windows", () => {
    const split = [
      { start: "08:00", end: "12:00" },
      { start: "14:00", end: "18:00" },
    ];
    expect(i13OutsideTimeWindow(shift(split, "2026-09-08T15:00:00+08:00")).status).toBe("clear");
    expect(i13OutsideTimeWindow(shift(split, "2026-09-08T13:00:00+08:00")).status).toBe("triggered");
  });

  it("reads the local wall clock through the event's own offset", () => {
    // 02:30 UTC is 10:30 in +08:00, inside the shift. A naive UTC read would
    // place it outside and flag an honest courier.
    const input = shift([{ start: "08:00", end: "18:00" }], "2026-09-08T02:30:00+00:00");
    (input.event as { eventTimeZoneOffset: string }).eventTimeZoneOffset = "+08:00";
    expect(i13OutsideTimeWindow(input).status).toBe("clear");
  });

  it("handles a negative UTC offset", () => {
    const input = shift([{ start: "08:00", end: "18:00" }], "2026-09-08T14:30:00-05:00");
    (input.event as { eventTimeZoneOffset: string }).eventTimeZoneOffset = "-05:00";
    expect(i13OutsideTimeWindow(input).status).toBe("clear");
  });

  it("does not evaluate when the mandate places no restriction on hours", () => {
    expectSkipped(i13OutsideTimeWindow(makeInput()), /no restriction on hours/);
  });

  it("does not evaluate when there is no mandate", () => {
    expectSkipped(i13OutsideTimeWindow(makeInput({ mandate: undefined })), /no restriction on hours/);
  });

  it("does not evaluate an unparsable event time", () => {
    const input = shift([{ start: "08:00", end: "18:00" }], "2026-09-08T10:00:00+08:00");
    (input.event as { eventTime: string }).eventTime = "not-a-date";
    expectSkipped(i13OutsideTimeWindow(input), /not parsable/);
  });
});

describe("I14 - battery use vs distance travelled", () => {
  const journey = (over: { levelPercent?: number; charging?: boolean; previousBattery?: number } = {}) =>
    patchSensor(
      {
        gps: { point: { ...SHAH_ALAM, accuracyMeters: 8 }, fixTime: "2026-09-08T10:15:00+08:00", mockLocationProvider: false },
        battery: { levelPercent: over.levelPercent ?? 68, charging: over.charging ?? false },
      },
      {
        previous: {
          eventTime: "2026-09-08T09:45:00+08:00",
          point: KL_AMPANG_NEXT_BLOCK,
          batteryPercent: over.previousBattery ?? 68,
        },
      },
    );

  it("triggers when a 23 km journey cost no battery at all", () => {
    const flag = flagOf(i14BatteryMismatch(journey()));

    expect(flag.id).toBe("I14");
    expect(flag.points).toBe(10);
    expect(flag.evidence).toContainEqual({ field: "computed.dropPercentPoints", value: 0 });
  });

  it("does not trigger on the near-miss: a 1 point drop over the same journey", () => {
    expect(i14BatteryMismatch(journey({ previousBattery: 69 })).status).toBe("clear");
  });

  it("does not evaluate a journey too short to imply measurable drain", () => {
    expectSkipped(i14BatteryMismatch(makeInput()), /too short/);
  });

  it("does not evaluate while the device was charging, which masks drain", () => {
    expectSkipped(i14BatteryMismatch(journey({ charging: true })), /charging/);
  });

  it("does not evaluate without a previous battery reading", () => {
    const input = makeInput({ previous: { eventTime: "2026-09-08T09:45:00+08:00", point: SHAH_ALAM } });
    expectSkipped(i14BatteryMismatch(input), /no previous battery/);
  });

  it("does not evaluate without a battery reading on this event", () => {
    expectSkipped(i14BatteryMismatch(patchSensor({ battery: undefined })), /no battery reading/);
  });

  it("does not evaluate without a previous position - S6's absence path", () => {
    const input = patchSensor(
      { battery: { levelPercent: 68, charging: false } },
      { previous: { eventTime: "2026-09-08T09:45:00+08:00", batteryPercent: 68 } },
    );
    expectSkipped(i14BatteryMismatch(input), /no previous position/);
  });
});

describe("I15 - OTP claim vs independent verifier record", () => {
  it("triggers when a courier presents a receipt that was delivered to another recipient channel", () => {
    const input = makeInput({
      otpChallenge: {
        challengeId: "4be4cb19-a04a-4e93-8e9a-287108ae68e2",
        epc: "urn:epc:id:sgtin:0614141.107346.2017",
        recipientChannelFingerprint: "sha256:other-recipient",
        deliveryStatus: "delivered",
        verificationReceiptId: "5c59c087-bf4c-48ae-a0d2-cb68e3de021d",
        issuedAt: "2026-09-08T10:05:00+08:00",
        expiresAt: "2026-09-08T10:15:00+08:00",
        verifiedAt: "2026-09-08T10:12:00+08:00",
        consumedByEventId: "6f8c0d3e-4a1b-4c2d-9e5f-2b7a1c3d4e5f",
      },
    });

    const flag = flagOf(i15OtpProvenanceConflict(input));
    expect(flag.id).toBe("I15");
    expect(flag.points).toBe(40);
    expect(flag.evidence).toContainEqual({
      field: "otpChallenge.recipientChannelFingerprint",
      value: "sha256:other-recipient",
    });
    expect(flag.evidence).toContainEqual({
      field: "parcel.recipientChannelFingerprint",
      value: "sha256:registered-recipient",
    });
  });

  it("is clear when the server record binds the receipt to this parcel, channel and event", () => {
    expect(i15OtpProvenanceConflict(makeInput()).status).toBe("clear");
  });

  it("triggers when an event claims a receipt the verifier never issued", () => {
    const input = makeInput({
      otpChallenge: {
        ...makeInput().otpChallenge!,
        verificationReceiptId: "6b5c739b-9512-47e2-91fb-a1aebd79c2f2",
      },
    });

    expect(flagOf(i15OtpProvenanceConflict(input)).evidence).toContainEqual({
      field: "sensor.pod.otp.verificationReceiptId",
      value: "5c59c087-bf4c-48ae-a0d2-cb68e3de021d",
    });
  });

  it("reports every verifier-side binding that contradicts the event", () => {
    const input = makeInput({
      otpChallenge: {
        ...makeInput().otpChallenge!,
        challengeId: "7ca532f0-d5de-4de5-a436-b9618877c127",
        epc: "urn:epc:id:sgtin:0614141.107346.9999",
        deliveryStatus: "failed",
        verificationReceiptId: null,
        verifiedAt: null,
        consumedByEventId: "8f52447b-bdb7-483c-9312-62db3151f403",
      },
    });

    const fields = flagOf(i15OtpProvenanceConflict(input)).evidence.map((entry) => entry.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        "sensor.pod.otp.challengeId",
        "otpChallenge.challengeId",
        "parcel.epc",
        "otpChallenge.epc",
        "otpChallenge.deliveryStatus",
        "otpChallenge.verifiedAt",
        "otpChallenge.consumedByEventId",
        "event.eventID",
      ]),
    );
  });

  it("rejects a verifier receipt completed after the challenge expired", () => {
    const input = makeInput({
      otpChallenge: {
        ...makeInput().otpChallenge!,
        expiresAt: "2026-09-08T10:10:00+08:00",
        verifiedAt: "2026-09-08T10:12:00+08:00",
      },
    });

    expect(flagOf(i15OtpProvenanceConflict(input)).evidence).toEqual(
      expect.arrayContaining([
        { field: "otpChallenge.verifiedAt", value: "2026-09-08T10:12:00+08:00" },
        { field: "otpChallenge.expiresAt", value: "2026-09-08T10:10:00+08:00" },
      ]),
    );
  });

  it("does not evaluate without opaque OTP references on the event", () => {
    const input = patchSensor({ pod: { otpVerified: true } });
    expectSkipped(i15OtpProvenanceConflict(input), /did not carry OTP provenance/);
  });

  it("does not evaluate without a registered recipient channel", () => {
    const input = makeInput({
      parcel: { ...makeInput().parcel!, recipientChannelFingerprint: undefined },
    });
    expectSkipped(i15OtpProvenanceConflict(input), /no registered recipient channel/);
  });

  it("does not turn a missing verifier record into clean evidence", () => {
    expectSkipped(i15OtpProvenanceConflict(makeInput({ otpChallenge: undefined })), /no OTP challenge record/);
  });

  it("does not evaluate an unknown delivery receipt as if the channel were confirmed", () => {
    const input = makeInput({
      otpChallenge: { ...makeInput().otpChallenge!, deliveryStatus: "unknown" },
    });
    expectSkipped(i15OtpProvenanceConflict(input), /delivery status is unknown/);
  });

  it("is gated away from non-delivery scans", () => {
    const input = makeInput({
      event: makeEvent({ bizStep: "urn:epcglobal:cbv:bizstep:storing" }),
    });
    expectSkipped(i15OtpProvenanceConflict(input), /not a delivery event/);
  });
});

describe("I16 - attestation assurance vs enrolled handset requirement", () => {
  it("triggers at 20 points when a passed attestation is weaker than enrollment", () => {
    const input = patchSensor({
      integrity: {
        attestationSource: "mocked",
        verdict: "passed",
        rootDetected: false,
        appTampered: false,
        deviceRecognitionVerdicts: ["MEETS_BASIC_INTEGRITY"],
      },
    });

    const flag = flagOf(i16AttestationBelowEnrollment(input));
    expect(flag.id).toBe("I16");
    expect(flag.points).toBe(20);
    expect(flag.evidence).toContainEqual({
      field: "deviceEnrollment.requiredRecognitionVerdict",
      value: "MEETS_DEVICE_INTEGRITY",
    });
  });

  it("is clear when the live attestation meets the enrolled requirement", () => {
    expect(i16AttestationBelowEnrollment(makeInput()).status).toBe("clear");
  });

  it("does not evaluate when the provider supplied no recognition labels", () => {
    const input = makeInput();
    expectSkipped(
      i16AttestationBelowEnrollment(
        patchSensor({ integrity: { ...input.sensor!.integrity!, deviceRecognitionVerdicts: undefined } }),
      ),
      /no device recognition labels/,
    );
  });

  it("leaves explicit failures to I8 instead of scoring the same signal twice", () => {
    const input = makeInput();
    expectSkipped(
      i16AttestationBelowEnrollment(
        patchSensor({ integrity: { ...input.sensor!.integrity!, verdict: "failed" } }),
      ),
      /I8 handles/,
    );
  });
});

describe("the rule registry", () => {
  it("covers exactly the 16 numbered checks in the spec", () => {
    const ids = INCONSISTENCY_RULES.flatMap((r) => r.ids);
    expect(ids).toEqual([
      "I1", "I2", "I3", "I4", "I5", "I6", "I7",
      "I8", "I9", "I10", "I11", "I12", "I13", "I14", "I15", "I16",
    ]);
    expect(TOTAL_CHECKS).toBe(16);
  });

  it("never returns points a rule did not earn - every flag id is in the registry", () => {
    const known = new Set(INCONSISTENCY_RULES.flatMap((r) => r.ids));
    for (const rule of INCONSISTENCY_RULES) {
      const result = rule.run(withSensor(undefined));
      if (result.status === "triggered") expect(known.has(result.flag.id)).toBe(true);
    }
  });

  it("gives every point value a name in the thresholds module", () => {
    // No rule may hardcode a score: experiment 6 varies these programmatically.
    const values = Object.values(DEFAULT_THRESHOLDS.points);
    expect(values.every((v) => typeof v === "number" && v > 0)).toBe(true);
  });
});

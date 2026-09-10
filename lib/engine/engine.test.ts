import { describe, expect, it } from "vitest";
import { runInconsistencyEngine } from "./engine";
import { DEFAULT_THRESHOLDS, matchBand } from "./thresholds";
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
import type { EngineInput } from "./types";
import type { BizStep, Disposition, GeoPoint } from "@/lib/epcis";

describe("hard checks abort", () => {
  it("suppresses all scoring when a hard check fails", () => {
    // An out-of-scope EPC that would ALSO have scored heavily on I-rules.
    const result = runInconsistencyEngine(
      makeInput({
        event: makeEvent({ epcList: ["urn:epc:id:sgtin:0699999.500000.1"] }),
        sensor: {
          gps: {
            point: { ...IPOH, accuracyMeters: 8 },
            fixTime: "2026-09-08T10:15:00+08:00",
            mockLocationProvider: true,
          },
        },
      }),
    );

    expect(result.aborted).toBe(true);
    expect(result.abortCode).toBe("H2");
    expect(result.flags).toEqual([]);
    expect(result.score).toBe(0);
    expect(result.rawScore).toBe(0);
  });

  it("reports every hard failure at once rather than one at a time", () => {
    const result = runInconsistencyEngine(
      makeInput({
        // H1: delivered parcel being loaded again. H3: revoked mandate.
        event: makeEvent({ bizStep: "urn:epcglobal:cbv:bizstep:loading" }),
        previous: {
          eventTime: "2026-09-08T09:45:00+08:00",
          disposition: "urn:epcglobal:cbv:disp:retail_sold",
        },
        mandate: makeMandate({ status: "revoked" }),
      }),
    );

    expect(result.hardFailures.map((f) => f.id)).toEqual(["H1", "H3"]);
    expect(result.abortCode).toBe("H1");
  });

  it("says plainly that scoring did not run, rather than reporting a clean sheet", () => {
    const result = runInconsistencyEngine(makeInput({ mandate: makeMandate({ status: "paused" }) }));

    expect(result.coverage.evaluated).toBe(0);
    expect(result.coverage.notEvaluated[0].reason).toMatch(/hard check failed/);
  });
});

describe("scoring", () => {
  it("sums the flags that fired", () => {
    // I7 mock location (50) + I6 unbound device (25).
    const result = runInconsistencyEngine(
      makeInput({
        sensor: {
          deviceId: "HHT-9999",
          gps: {
            point: { ...KL_AMPANG_DOORSTEP, accuracyMeters: 8 },
            fixTime: "2026-09-08T10:15:00+08:00",
            speedMps: 0,
            mockLocationProvider: true,
          },
          motion: { windowSeconds: 60, meanAbsDeviationMs2: 0.4, maxAbsDeviationMs2: 1.2 },
          pod: {
            photoSha256: "a".repeat(64),
            photoExifCaptureTime: "2026-09-08T10:14:30+08:00",
            otpVerified: true,
            signatureSha256: "b".repeat(64),
          },
        },
      }),
    );

    expect(result.aborted).toBe(false);
    expect(result.flags.map((f) => f.id).sort()).toEqual(["I6", "I7"]);
    expect(result.score).toBe(75);
    expect(result.rawScore).toBe(75);
  });

  it("clamps the score at 100 but keeps rawScore unclamped for threshold sweeps", () => {
    // Everything wrong at once: I1 40 + I2 40 + I3 40 + I4 30 + I6 25 + I7 50
    // + I8 50 + I9 25 + I10 40 + I12 45 = 385.
    // recordTime is deliberately earlier than eventTime: this arithmetic fixture
    // was flipped when I4 became directional so it still tests a device-ahead
    // contradiction, not the queued-upload direction that exposed the old bug.
    const result = runInconsistencyEngine(
      makeInput({
        event: makeEvent({ eventTime: "2026-09-08T10:15:00+08:00", recordTime: "2026-09-08T08:00:00+08:00" }),
        sensor: {
          deviceId: "HHT-9999",
          gps: {
            point: { ...IPOH, accuracyMeters: 8 },
            fixTime: "2026-09-08T10:15:00+08:00",
            speedMps: 30,
            mockLocationProvider: true,
          },
          motion: { windowSeconds: 60, meanAbsDeviationMs2: 0.001, maxAbsDeviationMs2: 0.01 },
          integrity: {
            attestationSource: "mocked",
            verdict: "failed",
            rootDetected: true,
            appTampered: true,
          },
          pod: { photoExifCaptureTime: "2026-09-08T08:00:00+08:00" },
        },
      }),
    );

    expect(result.score).toBe(100);
    expect(result.rawScore).toBeGreaterThan(100);
    expect(result.rawScore).toBe(385);
  });

  it("never scores a tiered pair twice", () => {
    // 45 device-ahead minutes AND 23 km off the address: I4 (30) + I10 (40).
    // This arithmetic fixture was flipped from server-late to device-ahead when
    // the absolute-value bug was fixed; it tests tier exclusivity, not direction.
    const result = runInconsistencyEngine(
      makeInput({
        event: makeEvent({ eventTime: "2026-09-08T10:15:00+08:00", recordTime: "2026-09-08T09:30:00+08:00" }),
        sensor: {
          deviceId: "HHT-0042",
          gps: {
            point: { ...SHAH_ALAM, accuracyMeters: 8 },
            fixTime: "2026-09-08T10:15:00+08:00",
            speedMps: 0,
            mockLocationProvider: false,
          },
          motion: { windowSeconds: 60, meanAbsDeviationMs2: 0.4, maxAbsDeviationMs2: 1.2 },
          pod: {
            photoSha256: "a".repeat(64),
            photoExifCaptureTime: "2026-09-08T10:14:30+08:00",
            otpVerified: true,
            signatureSha256: "b".repeat(64),
          },
        },
        referenceSites: undefined,
      }),
    );

    expect(result.flags.map((f) => f.id).sort()).toEqual(["I10", "I4"]);
    expect(result.rawScore).toBe(70);
  });
});

describe("coverage — missing evidence is not clean evidence", () => {
  it("reports which checks could not be evaluated, and why", () => {
    const result = runInconsistencyEngine(makeInput());

    expect(result.coverage.total).toBe(16);
    // I13 (mandate sets no hours) and I14 (journey too short) cannot be evaluated.
    expect(result.coverage.notEvaluated.map((n) => n.id).sort()).toEqual(["I13", "I14"]);
    expect(result.coverage.evaluated).toBe(14);
  });

  it("distinguishes a clean event from an event with almost no evidence", () => {
    const clean = runInconsistencyEngine(makeInput());
    const blind = runInconsistencyEngine(
      makeInput({
        event: makeEvent({ bizStep: "urn:epcglobal:cbv:bizstep:transporting" }),
        sensor: undefined,
        previous: undefined,
        referenceSites: undefined,
      }),
    );

    // Both score zero. Only one of them means anything.
    expect(clean.score).toBe(0);
    expect(blind.score).toBe(0);
    expect(clean.coverage.evaluated).toBe(14);

    // Not zero: the device/server clock comparison needs nothing from the
    // handset, so I4/I5 remain evaluable even when the device reported no
    // signals whatsoever. That is the one check a silent device cannot dodge.
    expect(blind.coverage.evaluated).toBe(2);
    expect(blind.coverage.notEvaluated).toHaveLength(14);
  });

  it("counts both ids of a tiered rule toward the 16, so the operator's line reads 16", () => {
    const result = runInconsistencyEngine(
      makeInput({ event: makeEvent({ recordTime: undefined }) }),
    );
    const clockIds = result.coverage.notEvaluated.filter((n) => n.id === "I4" || n.id === "I5");
    expect(clockIds).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* S0 — the false-positive regression test                                    */
/* -------------------------------------------------------------------------- */

/**
 * A normal shipment, end to end. Nothing about it is suspicious.
 *
 * This is the regression test that protects the "fewer false alerts" claim: if
 * a future rule change makes any ordinary leg of an ordinary parcel score above
 * the flag threshold, this test fails before the claim reaches a judge.
 */
describe("S0 — a normal shipment produces no flags at any leg", () => {
  const KL_HUB: GeoPoint = { latitude: 3.1319, longitude: 101.6841 };
  const SHAH_ALAM_HUB: GeoPoint = KL_AMPANG_NEXT_BLOCK;

  type Leg = {
    name: string;
    bizStep: BizStep;
    previousDisposition: Disposition;
    eventTime: string;
    previousTime: string;
    point: GeoPoint;
    previousPoint: GeoPoint;
    battery: number;
    previousBattery: number;
  };

  const legs: Leg[] = [
    {
      name: "collection",
      bizStep: "urn:epcglobal:cbv:bizstep:receiving",
      previousDisposition: "urn:epcglobal:cbv:disp:active",
      previousTime: "2026-09-07T14:00:00+08:00",
      eventTime: "2026-09-07T14:30:00+08:00",
      previousPoint: KL_HUB,
      point: KL_HUB,
      previousBattery: 96,
      battery: 94,
    },
    {
      name: "sortation inbound",
      bizStep: "urn:epcglobal:cbv:bizstep:storing",
      previousDisposition: "urn:epcglobal:cbv:disp:active",
      previousTime: "2026-09-07T14:30:00+08:00",
      eventTime: "2026-09-07T19:10:00+08:00",
      previousPoint: KL_HUB,
      point: KL_HUB,
      previousBattery: 94,
      battery: 71,
    },
    {
      name: "line-haul departure",
      bizStep: "urn:epcglobal:cbv:bizstep:departing",
      previousDisposition: "urn:epcglobal:cbv:disp:in_progress",
      previousTime: "2026-09-07T19:10:00+08:00",
      eventTime: "2026-09-07T21:40:00+08:00",
      previousPoint: KL_HUB,
      point: KL_HUB,
      previousBattery: 71,
      battery: 58,
    },
    {
      name: "line-haul arrival",
      bizStep: "urn:epcglobal:cbv:bizstep:arriving",
      previousDisposition: "urn:epcglobal:cbv:disp:in_transit",
      previousTime: "2026-09-07T21:40:00+08:00",
      eventTime: "2026-09-08T06:15:00+08:00",
      previousPoint: KL_HUB,
      point: SHAH_ALAM_HUB,
      previousBattery: 58,
      battery: 30,
    },
    {
      name: "out for delivery",
      bizStep: "urn:epcglobal:cbv:bizstep:transporting",
      previousDisposition: "urn:epcglobal:cbv:disp:in_possession",
      previousTime: "2026-09-08T06:15:00+08:00",
      eventTime: "2026-09-08T09:45:00+08:00",
      previousPoint: SHAH_ALAM_HUB,
      point: SHAH_ALAM_HUB,
      previousBattery: 99,
      battery: 88,
    },
    {
      name: "delivery",
      bizStep: "urn:epcglobal:cbv:bizstep:delivering",
      previousDisposition: "urn:epcglobal:cbv:disp:in_possession",
      previousTime: "2026-09-08T09:45:00+08:00",
      eventTime: "2026-09-08T10:15:00+08:00",
      previousPoint: SHAH_ALAM_HUB,
      point: KL_AMPANG_DOORSTEP,
      previousBattery: 88,
      battery: 84,
    },
  ];

  function inputForLeg(leg: Leg): EngineInput {
    const isDelivery = leg.bizStep === "urn:epcglobal:cbv:bizstep:delivering";
    return makeInput({
      event: makeEvent({
        bizStep: leg.bizStep,
        eventTime: leg.eventTime,
        // Ordinary upload latency: far below the full-shift I5 band.
        recordTime: new Date(Date.parse(leg.eventTime) + 42_000).toISOString(),
      }),
      sensor: {
        deviceId: "HHT-0042",
        gps: {
          point: { ...leg.point, accuracyMeters: 11 },
          fixTime: leg.eventTime,
          speedMps: 0,
          mockLocationProvider: false,
        },
        motion: { windowSeconds: 60, meanAbsDeviationMs2: 0.31, maxAbsDeviationMs2: 1.4 },
        integrity: {
          attestationSource: "mocked",
          verdict: "passed",
          rootDetected: false,
          appTampered: false,
        },
        battery: { levelPercent: leg.battery, charging: false },
        pod: isDelivery
          ? {
              photoSha256: "c".repeat(64),
              photoExifCaptureTime: leg.eventTime,
              otpVerified: true,
              signatureSha256: "d".repeat(64),
            }
          : undefined,
      },
      previous: {
        eventTime: leg.previousTime,
        disposition: leg.previousDisposition,
        point: leg.previousPoint,
        batteryPercent: leg.previousBattery,
      },
      referenceSites: { cell: { id: "502-12-4501-90210", point: leg.point } },
      parcel: { epc: "urn:epc:id:sgtin:0614141.107346.2017", recipientPoint: KL_AMPANG },
    });
  }

  it.each(legs.map((l) => [l.name, l] as const))(
    "scores %s at zero with no hard failure",
    (_name, leg) => {
      const result = runInconsistencyEngine(inputForLeg(leg));

      expect(result.aborted).toBe(false);
      expect(result.hardFailures).toEqual([]);
      expect(result.flags).toEqual([]);
      expect(result.score).toBe(0);
    },
  );

  it("keeps the whole timeline clean, which is the false-positive claim in one assertion", () => {
    const scores = legs.map((leg) => runInconsistencyEngine(inputForLeg(leg)).score);
    expect(scores).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("still evaluates real checks on every leg - a clean sheet is not an empty sheet", () => {
    for (const leg of legs) {
      const result = runInconsistencyEngine(inputForLeg(leg));
      expect(result.coverage.evaluated).toBeGreaterThanOrEqual(6);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism and threshold configurability                                  */
/* -------------------------------------------------------------------------- */

describe("determinism", () => {
  it("returns an identical result for an identical input, every time", () => {
    const input = makeInput({
      sensor: {
        gps: {
          point: { ...SHAH_ALAM, accuracyMeters: 8 },
          fixTime: "2026-09-08T10:15:00+08:00",
          mockLocationProvider: true,
        },
      },
    });

    const runs = Array.from({ length: 20 }, () => runInconsistencyEngine(input));
    const first = JSON.stringify(runs[0]);
    for (const run of runs) expect(JSON.stringify(run)).toBe(first);
  });

  it("does not mutate its input", () => {
    const input = makeInput();
    const before = JSON.stringify(input);
    runInconsistencyEngine(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("threshold configurability — experiment 6", () => {
  it("changes the verdict when the speed limit is swept, without touching a rule", () => {
    const at119 = makeInput({
      sensor: {
        gps: {
          point: { latitude: 3.6939, longitude: 101.7123, accuracyMeters: 8 },
          fixTime: "2026-09-08T10:15:00+08:00",
          mockLocationProvider: false,
        },
      },
    });

    expect(runInconsistencyEngine(at119).flags.map((f) => f.id)).not.toContain("I3");

    const stricter: EngineInput = {
      ...at119,
      thresholds: { ...DEFAULT_THRESHOLDS, maxImpliedSpeedKmh: 80 },
    };
    expect(runInconsistencyEngine(stricter).flags.map((f) => f.id)).toContain("I3");
  });

  it("sweeps the band edges without restructuring control flow", () => {
    const deviceAheadBands = [{ id: "I4", atLeast: 10, points: 30 }];
    const uploadDelayBands = [{ id: "I5", atLeast: 20, points: 10 }];

    expect(matchBand(deviceAheadBands, 9)).toBeUndefined();
    expect(matchBand(deviceAheadBands, 10)?.id).toBe("I4");
    expect(matchBand(uploadDelayBands, 19)).toBeUndefined();
    expect(matchBand(uploadDelayBands, 20)?.id).toBe("I5");
  });

  it("ships thresholds frozen, so an experiment cannot corrupt the shared defaults", () => {
    expect(Object.isFrozen(DEFAULT_THRESHOLDS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_THRESHOLDS.points)).toBe(true);
  });
});

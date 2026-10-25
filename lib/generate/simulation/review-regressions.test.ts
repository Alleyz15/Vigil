import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { assembleEngineInput } from "@/lib/assemble";
import { closeDb } from "@/lib/db/client";
import { deviceEnrollments, otpChallenges } from "@/lib/db/schema";
import { i6UnboundDevice, i8IntegrityFailed, i16AttestationBelowEnrollment } from "@/lib/engine/inconsistency";
import { DEFAULT_THRESHOLDS } from "@/lib/engine/thresholds";
import { EpcisEvent, vigilSignalsOf } from "@/lib/epcis";
import { createHarness, seedIdentityReferences, type IngestHarness } from "../ingest";
import { NORMAL_LEGS, type BuiltEvent } from "../timeline";
import { buildWorld, prefixFor } from "../world";
import { buildSimulationHistory } from "./history";
import { buildSimulationTimeline } from "./signals";

// Reproductions from the review's existing manifest, not a search for new seeds.
const world = buildWorld("simulation-capabilities");
const courier = world.couriers[1];
const parcels = world.parcels.filter((parcel) => parcel.epc.startsWith(prefixFor(1)));
const startMs = Date.parse("2026-10-26T09:00:00+08:00");
const configFor = (seed: string) => ({ mode: "randomized", seed, version: "signals-v1" }) as const;
const args = { world, courier, parcel: parcels[0], startMs, idPrefix: "B-review", legs: NORMAL_LEGS };
const harnesses: IngestHarness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    closeDb(harness.deps.db);
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

describe("independent replacement enrollment", () => {
  it("keeps unknown replacement enrollment absent while retaining its OTP sidecar", () => {
    const result = buildSimulationTimeline({ ...args, config: configFor("capability-03") });
    const delivery = result.timeline.at(-1)!;
    expect(vigilSignalsOf(delivery.event)?.deviceId).toBe("HHT-1001-replacement");
    expect(delivery.identity?.deviceEnrollment).toBeUndefined();
    expect(delivery.identity?.otpChallenge).toMatchObject({
      challengeId: vigilSignalsOf(delivery.event)?.pod?.otp?.challengeId,
      consumedByEventId: delivery.event.eventID,
    });

    const harness = createHarness(world);
    harnesses.push(harness);
    seedIdentityReferences(harness, delivery);
    const { input } = assembleEngineInput(harness.deps.db, delivery.event, {
      courier: { courierId: courier.courierId, boundDeviceId: courier.deviceId },
    });
    expect(input.otpChallenge).toEqual(delivery.identity?.otpChallenge);
    expect(i6UnboundDevice(input).status).toBe("triggered");
    expect(i16AttestationBelowEnrollment(input).status).toBe("not_evaluated");
  });

  it("seeds an OTP-only sidecar without inserting or changing enrollment", () => {
    const delivery = buildSimulationTimeline({ ...args, config: configFor("capability-03") }).timeline.at(-1)!;
    const otp = delivery.identity!.otpChallenge!;
    const otpOnly: BuiltEvent = { ...delivery, identity: { otpChallenge: otp } };
    const harness = createHarness(world);
    harnesses.push(harness);
    const before = harness.deps.db.select().from(deviceEnrollments).all();
    expect(() => seedIdentityReferences(harness, otpOnly)).not.toThrow();
    expect(harness.deps.db.select().from(deviceEnrollments).all()).toEqual(before);
    expect(harness.deps.db.select().from(otpChallenges).where(eq(otpChallenges.challengeId, otp.challengeId)).get()).toMatchObject(otp);
  });

  it("takes a known handset's policy from its world enrollment, not scan overrides", () => {
    const owner = world.couriers[2];
    const delivery = buildSimulationTimeline({ ...args, config: configFor("capability-03"),
      overrides: { delivery: { deviceId: owner.deviceId, enrollmentCourierId: courier.courierId,
        requiredRecognitionVerdict: "MEETS_BASIC_INTEGRITY" } },
    }).timeline.at(-1)!;
    expect(delivery.identity?.deviceEnrollment).toMatchObject({ deviceId: owner.deviceId,
      courierId: owner.courierId, requiredRecognitionVerdict: owner.requiredRecognitionVerdict });
  });
});

describe("effective signal overrides", () => {
  it("keeps one clock for an explicitly selected device across the sampled replacement boundary", () => {
    const result = buildSimulationTimeline({ ...args, config: configFor("capability-03"),
      overrides: Object.fromEntries(NORMAL_LEGS.map((leg) => [leg.name, { deviceId: "same-explicit-device" }])),
    });
    const offsets = result.timeline.map((built, index) =>
      Date.parse(built.event.eventTime) - startMs - result.legs[index].offsetMinutes * 60_000);
    expect(new Set(offsets).size).toBe(1);
    expect(result.conditions.filter((condition) => condition.code.startsWith("clock:")).map((condition) => condition.code))
      .toEqual(["clock:same-explicit-device"]);
    for (const built of result.timeline) {
      expect(vigilSignalsOf(built.event)?.gps?.fixTime).toBe(built.event.eventTime);
      expect(EpcisEvent.parse(built.raw)).toEqual(built.event);
    }
  });

  it.each([false, true])("honors integrityFailed=%s in the event, rule result and provenance", (failed) => {
    const result = buildSimulationTimeline({ ...args, config: configFor("capability-04"),
      overrides: { delivery: { integrityFailed: failed } },
    });
    const delivery = result.timeline.at(-1)!;
    const sensor = vigilSignalsOf(delivery.event)!;
    expect(sensor.integrity).toMatchObject({ verdict: failed ? "failed" : "passed", rootDetected: failed });
    expect(i8IntegrityFailed({ event: delivery.event, sensor, thresholds: DEFAULT_THRESHOLDS }).status)
      .toBe(failed ? "triggered" : "clear");
    expect(result.conditions.some((condition) => condition.code === "delivery:integrity_failed")).toBe(failed);
    expect(result.conditions.some((condition) => condition.code === "delivery:integrity_unevaluated")).toBe(false);
    expect(EpcisEvent.parse(delivery.raw)).toEqual(delivery.event);
  });
});

describe("bootstrap battery narrative", () => {
  it("drains the same handset during a normal round instead of restarting at every parcel", () => {
    const result = buildSimulationHistory({ world, courier, parcels, startMs, idPrefix: "B-review",
      config: configFor("capability-10") });
    expect(result.bootstrap.profile).toBe("normal");
    const batteries = result.warmup.map((built) => vigilSignalsOf(built.event)!.battery!);
    expect(batteries.at(-1)!.levelPercent).toBeLessThan(batteries[0].levelPercent);
    for (let i = 1; i < batteries.length; i++) {
      expect(batteries[i].levelPercent).toBeLessThanOrEqual(batteries[i - 1].levelPercent);
      expect(batteries[i].charging).toBe(false);
      expect(EpcisEvent.parse(result.warmup[i].raw)).toEqual(result.warmup[i].event);
    }
  });

  it("uses elapsed activity and physical distance independently for battery drain", () => {
    const config = configFor("capability-10");
    const near = parcels.slice(-4).map((parcel) => ({ ...parcel, recipientPoint: { latitude: 3.1, longitude: 101.6 } }));
    const far = near.map((parcel, index) => ({ ...parcel,
      recipientPoint: { latitude: 3.1 + index * 0.1, longitude: 101.6 } }));
    const build = (input: typeof near) => buildSimulationHistory({ world, courier, parcels: input,
      startMs, idPrefix: "B-review", config });
    const nearRound = build(near);
    const farRound = build(far);
    const battery = (built: BuiltEvent) => vigilSignalsOf(built.event)!.battery!.levelPercent;
    expect(battery(nearRound.warmup.at(-1)!)).toBeLessThan(battery(nearRound.warmup[0]));
    expect(battery(farRound.warmup.at(-1)!)).toBeLessThan(battery(nearRound.warmup.at(-1)!));
  });
});

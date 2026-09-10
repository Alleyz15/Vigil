import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { EpcisEvent } from "@/lib/epcis";
import { runInconsistencyEngine } from "@/lib/engine";
import { runPatternEngine } from "@/lib/pattern";
import {
  COURIER_ID,
  DEVICE_ID,
  EPC,
  KL_AMPANG,
  type World,
  makeAgentEvent,
  resetEventIds,
  runSigned,
  seedDispute,
  seedWorld,
  signalsOf,
} from "@/lib/agent/fixtures";
import { eq } from "drizzle-orm";
import { deviceEnrollments, mandates, otpChallenges, parcels, verdicts } from "@/lib/db/schema";
import { assembleEngineInput } from "./engine-input";
import { assembleGateInput } from "./gate-input";
import { assemblePatternInput } from "./pattern-input";
import { loadActiveMandate } from "./mandate";
import { coverageLine, emptyResolution } from "./types";

/**
 * Assemblers, tested against a real seeded SQLite. No mocks: the query shapes
 * are the thing under test, and a mocked row proves nothing about a join.
 */

let world: World;

beforeEach(() => {
  resetEventIds();
  world = seedWorld();
});
afterEach(() => rmSync(world.dir, { recursive: true, force: true }));

const parseEvent = (raw: unknown) => EpcisEvent.parse(raw);

/**
 * Assemble with the courier's mandate in hand. Without it H2 fails, the engine
 * aborts, and no I-rule runs — which would make an absent-path test pass for
 * entirely the wrong reason.
 */
const assembleWithMandate = (db: World["deps"]["db"], event: ReturnType<typeof parseEvent>) =>
  assembleEngineInput(db, event, {
    courier: { courierId: COURIER_ID, boundDeviceId: DEVICE_ID },
    mandate: loadActiveMandate(db, COURIER_ID, emptyResolution()),
  });

describe("loadActiveMandate", () => {
  it("rebuilds the nested mandate from its flattened row", async () => {
    const resolution = emptyResolution();
    const mandate = loadActiveMandate(world.deps.db, COURIER_ID, resolution);

    expect(mandate?.mandateId).toBe("MD-0001");
    expect(mandate?.scope.epcPrefixes).toEqual(["urn:epc:id:sgtin:0614141.107346."]);
    expect(mandate?.limits.maxHandoffsPerShift).toBe(60);
    expect(resolution.resolved).toContain("mandate MD-0001");
  });

  it("returns undefined and says why when there is no active mandate", async () => {
    world.deps.db.update(mandates).set({ status: "revoked" }).run();

    const resolution = emptyResolution();
    expect(loadActiveMandate(world.deps.db, COURIER_ID, resolution)).toBeUndefined();
    expect(resolution.missing[0].reason).toMatch(/no active mandate/);
  });

  it("fails closed on malformed JSON rather than building a partial mandate", async () => {
    world.deps.db.update(mandates).set({ validityJson: "}{" }).run();

    const resolution = emptyResolution();
    expect(loadActiveMandate(world.deps.db, COURIER_ID, resolution)).toBeUndefined();
    expect(resolution.missing[0].reason).toMatch(/malformed JSON/);
  });

  it("fails closed when the JSON parses but does not satisfy the schema", async () => {
    world.deps.db.update(mandates).set({ scopeJson: '{"epcPrefixes":"not-an-array"}' }).run();

    const resolution = emptyResolution();
    expect(loadActiveMandate(world.deps.db, COURIER_ID, resolution)).toBeUndefined();
    expect(resolution.missing[0].reason).toMatch(/does not satisfy the schema/);
  });
});

describe("assembleEngineInput", () => {
  it("resolves the parcel, its coordinates and the observed reference sites", async () => {
    const event = parseEvent(makeAgentEvent());
    const { input, resolution } = assembleEngineInput(world.deps.db, event);

    expect(input.parcel?.recipientPoint).toEqual(KL_AMPANG);
    expect(input.referenceSites?.cell?.id).toBe("502-12-4501-90210");
    expect(input.referenceSites?.wifi).toHaveLength(1);
    expect(resolution.resolved).toContain("recipientPoint");
  });

  it("reports no previous event for the first scan in a timeline", async () => {
    const event = parseEvent(makeAgentEvent());
    const { input, resolution } = assembleEngineInput(world.deps.db, event);

    expect(input.previous).toBeUndefined();
    expect(resolution.missing.map((m) => m.reason).join(" ")).toMatch(/first in its timeline/);
  });

  it("finds the immediately preceding event once one has been stored", async () => {
    const first = makeAgentEvent({ eventTime: "2026-09-08T09:45:00+08:00" });
    await runSigned(first, world);

    const second = parseEvent(makeAgentEvent({ eventTime: "2026-09-08T10:15:00+08:00" }));
    const { input } = assembleEngineInput(world.deps.db, second);

    expect(input.previous?.eventTime).toBe("2026-09-08T09:45:00+08:00");
    // Read back out of the stored payload, not from a denormalised column.
    expect(input.previous?.point).toBeDefined();
    expect(input.previous?.batteryPercent).toBe(61);
  });

  /**
   * THE ABSENT PATH. A region with no registered sites must flow through as
   * `not_evaluated`, never as a fabricated site — inventing one would
   * manufacture the very contradiction I1 exists to detect.
   */
  it("leaves referenceSites undefined when the region has none on file", async () => {
    const bare = seedWorld({ withReferenceSites: false });
    try {
      const event = parseEvent(makeAgentEvent());
      const { input, resolution } = assembleWithMandate(bare.deps.db, event);

      expect(input.referenceSites).toBeUndefined();
      expect(resolution.missing.map((m) => m.what)).toContain("referenceSites");

      // And the rule downstream says not_evaluated, not clear.
      const result = runInconsistencyEngine(input);
      expect(result.flags.map((f) => f.id)).not.toContain("I1");
      expect(result.coverage.notEvaluated.map((n) => n.id)).toContain("I1");
    } finally {
      rmSync(bare.dir, { recursive: true, force: true });
    }
  });

  it("leaves recipientPoint undefined when the parcel has no coordinates", async () => {
    const noCoords = seedWorld({ recipientPoint: null });
    try {
      const event = parseEvent(makeAgentEvent());
      const { input, resolution } = assembleWithMandate(noCoords.deps.db, event);

      expect(input.parcel?.recipientPoint).toBeUndefined();
      expect(resolution.missing.map((m) => m.what)).toContain("recipientPoint");

      const result = runInconsistencyEngine(input);
      expect(result.coverage.notEvaluated.map((n) => n.id)).toContain("I10");
    } finally {
      rmSync(noCoords.dir, { recursive: true, force: true });
    }
  });

  it("reports a missing parcel rather than inventing one", async () => {
    const event = parseEvent(makeAgentEvent({ epcList: ["urn:epc:id:sgtin:0614141.107346.7777"] }));
    const { input, resolution } = assembleEngineInput(world.deps.db, event);

    expect(input.parcel).toBeUndefined();
    expect(resolution.missing.map((m) => m.what)).toContain("parcel");
  });

  it("resolves independent OTP provenance and device enrollment records", async () => {
    const challengeId = "10000000-0000-4000-8000-000000000001";
    const receiptId = "20000000-0000-4000-8000-000000000001";
    const raw = makeAgentEvent();
    const signals = signalsOf(raw);
    (signals.integrity as Record<string, unknown>).deviceRecognitionVerdicts = [
      "MEETS_DEVICE_INTEGRITY",
    ];
    (signals.pod as Record<string, unknown>).otp = {
      challengeId,
      verificationReceiptId: receiptId,
    };
    const event = parseEvent(raw);

    world.deps.db
      .update(parcels)
      .set({ recipientPhone: "+60123456789" })
      .where(eq(parcels.epc, EPC))
      .run();
    world.deps.db.insert(otpChallenges).values({
      challengeId,
      epc: EPC,
      // SHA-256 of the normalised E.164 channel. This literal keeps the test
      // independent of the helper that computes it in production.
      recipientChannelFingerprint:
        "88030e91922da507d9b1ffa68d9896f94313acc33ec5b15c72eca420a6fe775b",
      deliveryStatus: "delivered",
      verificationReceiptId: receiptId,
      issuedAt: "2026-09-08T02:10:00.000Z",
      expiresAt: "2026-09-08T02:20:00.000Z",
      verifiedAt: "2026-09-08T02:14:50.000Z",
      consumedByEventId: event.eventID,
    }).run();
    world.deps.db.insert(deviceEnrollments).values({
      deviceId: DEVICE_ID,
      courierId: COURIER_ID,
      requiredRecognitionVerdict: "MEETS_DEVICE_INTEGRITY",
      status: "active",
      enrolledAt: "2026-09-01T00:00:00.000Z",
    }).run();

    const { input, resolution } = assembleWithMandate(world.deps.db, event);

    expect(input.parcel?.recipientChannelFingerprint).toBe(
      "88030e91922da507d9b1ffa68d9896f94313acc33ec5b15c72eca420a6fe775b",
    );
    expect(input.otpChallenge).toMatchObject({ challengeId, verificationReceiptId: receiptId });
    expect(input.deviceEnrollment).toEqual({
      deviceId: DEVICE_ID,
      requiredRecognitionVerdict: "MEETS_DEVICE_INTEGRITY",
    });
    expect(resolution.resolved).toContain(`OTP challenge ${challengeId}`);
    expect(resolution.resolved).toContain(`device enrollment ${DEVICE_ID}`);

    const result = runInconsistencyEngine(input);
    expect(result.flags.map((flag) => flag.id)).not.toContain("I15");
    expect(result.flags.map((flag) => flag.id)).not.toContain("I16");
    expect(result.coverage.notEvaluated.map((entry) => entry.id)).not.toContain("I15");
    expect(result.coverage.notEvaluated.map((entry) => entry.id)).not.toContain("I16");
  });

  it("leaves absent identity reference records not_evaluated instead of fabricating defaults", async () => {
    const raw = makeAgentEvent();
    const signals = signalsOf(raw);
    (signals.integrity as Record<string, unknown>).deviceRecognitionVerdicts = [
      "MEETS_DEVICE_INTEGRITY",
    ];
    (signals.pod as Record<string, unknown>).otp = {
      challengeId: "10000000-0000-4000-8000-000000000002",
      verificationReceiptId: "20000000-0000-4000-8000-000000000002",
    };
    const event = parseEvent(raw);

    world.deps.db
      .update(parcels)
      .set({ recipientPhone: "+60123456789" })
      .where(eq(parcels.epc, EPC))
      .run();

    const { input, resolution } = assembleWithMandate(world.deps.db, event);
    expect(input.otpChallenge).toBeUndefined();
    expect(input.deviceEnrollment).toBeUndefined();
    expect(resolution.missing.map((entry) => entry.what)).toEqual(
      expect.arrayContaining(["otpChallenge", "deviceEnrollment"]),
    );

    const result = runInconsistencyEngine(input);
    expect(result.coverage.notEvaluated.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["I15", "I16"]),
    );
  });
});

describe("assemblePatternInput", () => {
  /** Seal `n` deliveries, five minutes apart, so they become past handoffs. */
  async function sealHandoffs(w: World, n: number, startAt = "2026-09-08T08:00:00+08:00") {
    const ids: string[] = [];
    const base = Date.parse(startAt);
    for (let i = 0; i < n; i++) {
      const eventTime = new Date(base + i * 5 * 60_000).toISOString().replace("Z", "+00:00");
      const event = makeAgentEvent({ eventTime, recordTime: eventTime });
      const ctx = await runSigned(event, w);
      if (ctx.event) ids.push(ctx.event.eventID);
    }
    return ids;
  }

  it("returns the courier's sealed handoffs within the window", async () => {
    await sealHandoffs(world, 4);

    const { input } = assemblePatternInput(
      world.deps.db,
      COURIER_ID,
      "2026-09-08T12:00:00+08:00",
    );

    expect(input.handoffs).toHaveLength(4);
    expect(input.handoffs[0].inconsistencyScore).toBe(0);
    expect(input.courierId).toBe(COURIER_ID);
  });

  it("excludes events that have no sealed verdict rather than scoring them zero", async () => {
    // P3 measures the SPREAD of axis-1 scores; substituting a zero for an
    // unscored event would fabricate the tightness P3 looks for.
    await sealHandoffs(world, 3);
    // A stored event with no verdict row: ingested but never adjudicated.
    world.deps.db.delete(verdicts).where(eq(verdicts.ledgerSeq, 0)).run();

    const { input, resolution } = assemblePatternInput(
      world.deps.db,
      COURIER_ID,
      "2026-09-08T12:00:00+08:00",
    );

    expect(input.handoffs).toHaveLength(2);
    expect(resolution.missing.map((m) => m.reason).join(" ")).toMatch(/no sealed verdict/);
  });

  it("carries dispute records through to the pattern rules", async () => {
    const ids = await sealHandoffs(world, 4);
    seedDispute(world.deps.db, ids[0]);

    const { input } = assemblePatternInput(world.deps.db, COURIER_ID, "2026-09-08T12:00:00+08:00");

    expect(input.handoffs.filter((h) => h.disputed)).toHaveLength(1);
  });

  it("computes the queue baseline from the same rows an auditor could recount", async () => {
    const ids = await sealHandoffs(world, 4);
    seedDispute(world.deps.db, ids[0]);

    const { input } = assemblePatternInput(world.deps.db, COURIER_ID, "2026-09-08T12:00:00+08:00");

    expect(input.queueBaseline?.sampleSize).toBe(4);
    expect(input.queueBaseline?.disputeRate).toBeCloseTo(0.25, 5);
  });

  it("reports no baseline when the fleet has no deliveries to compare against", async () => {
    const { input, resolution } = assemblePatternInput(
      world.deps.db,
      COURIER_ID,
      "2026-09-08T12:00:00+08:00",
    );

    expect(input.queueBaseline).toBeUndefined();
    expect(resolution.missing.map((m) => m.what)).toContain("queueBaseline");

    // P2 then reports not_evaluated rather than measuring against a zero.
    const outcome = runPatternEngine(input);
    expect(outcome.coverage.notEvaluated.map((n) => n.id)).toContain("P2");
  });

  it("reports cold start for a courier with too little history", async () => {
    await sealHandoffs(world, 3);

    const { input } = assemblePatternInput(world.deps.db, COURIER_ID, "2026-09-08T12:00:00+08:00");
    const outcome = runPatternEngine(input);

    expect(outcome.coldStart).toBe(true);
    expect(outcome.score).toBe(0);
    expect(outcome.coldStartReason).toMatch(/at least 10/);
  });

  it("honours the window: events outside it are not in the sample", async () => {
    await sealHandoffs(world, 4, "2026-09-06T08:00:00+08:00");

    const { input } = assemblePatternInput(world.deps.db, COURIER_ID, "2026-09-08T12:00:00+08:00", {
      windowHours: 24,
    });

    expect(input.handoffs).toHaveLength(0);
  });
});

describe("assembleGateInput", () => {
  const emptyAxis1 = () =>
    runInconsistencyEngine(assembleWithMandate(world.deps.db, parseEvent(makeAgentEvent())).input);

  it("counts handoffs this shift from the courier/time index", async () => {
    await runSigned(makeAgentEvent({ eventTime: "2026-09-08T09:00:00+08:00" }), world);
    await runSigned(makeAgentEvent({ eventTime: "2026-09-08T09:30:00+08:00" }), world);

    const { input } = assembleGateInput(world.deps.db, {
      inconsistency: emptyAxis1(),
      pattern: runPatternEngine(
        assemblePatternInput(world.deps.db, COURIER_ID, "2026-09-08T10:15:00+08:00").input,
      ),
      courierId: COURIER_ID,
      epc: EPC,
      now: "2026-09-08T10:15:00+08:00",
    });

    expect(input.shift?.handoffsThisShift).toBe(2);
  });

  it("finds the last high-risk handoff for the cooldown check", async () => {
    // A spoofed event scores high enough to be flagged.
    const spoofed = makeAgentEvent({ eventTime: "2026-09-08T09:00:00+08:00" });
    const signals = signalsOf(spoofed);
    (signals.gps as { mockLocationProvider: boolean }).mockLocationProvider = true;
    const flagged = await runSigned(spoofed, world);
    expect(flagged.decision).not.toBe("accept");

    const { input } = assembleGateInput(world.deps.db, {
      inconsistency: emptyAxis1(),
      pattern: runPatternEngine(
        assemblePatternInput(world.deps.db, COURIER_ID, "2026-09-08T10:15:00+08:00").input,
      ),
      courierId: COURIER_ID,
      epc: EPC,
      now: "2026-09-08T10:15:00+08:00",
    });

    expect(input.shift?.lastHighRiskHandoffAt).toBe("2026-09-08T09:00:00+08:00");
  });

  it("reads the parcel's value for the co-sign conditions", async () => {
    const { input } = assembleGateInput(world.deps.db, {
      inconsistency: emptyAxis1(),
      pattern: runPatternEngine(
        assemblePatternInput(world.deps.db, COURIER_ID, "2026-09-08T10:15:00+08:00").input,
      ),
      courierId: COURIER_ID,
      epc: EPC,
      now: "2026-09-08T10:15:00+08:00",
    });

    expect(input.parcel?.declaredValueSen).toBe(12_000);
    expect(input.parcel?.recipientAddressInScope).toBe(true);
  });

  it("reports a missing parcel rather than inventing a value of zero", async () => {
    const { input, resolution } = assembleGateInput(world.deps.db, {
      inconsistency: emptyAxis1(),
      pattern: runPatternEngine(
        assemblePatternInput(world.deps.db, COURIER_ID, "2026-09-08T10:15:00+08:00").input,
      ),
      courierId: COURIER_ID,
      epc: "urn:epc:id:sgtin:0614141.107346.7777",
      now: "2026-09-08T10:15:00+08:00",
    });

    expect(input.parcel).toBeUndefined();
    expect(resolution.missing.map((m) => m.what)).toContain("parcelValue");
  });
});

describe("coverageLine", () => {
  it("renders the operator's line from the engine's own counts", async () => {
    expect(coverageLine({ evaluated: 12, total: 16 })).toBe("12 of 16 checks evaluable");
  });
});

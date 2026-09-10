import { describe, expect, it } from "vitest";
import { vigilSignalsOf } from "@/lib/epcis";
import { NOISE_LEVELS, type NoiseLevel, SKIPPABLE_LEGS, planShipmentNoise } from "./noise";
import { recipientChannelFingerprint } from "@/lib/identity/channel";
import { makeRng } from "./rng";
import { buildScenario } from "./scenarios";
import { type BuiltEvent, buildTimeline } from "./timeline";
import { buildWorld } from "./world";

/**
 * The noise model.
 *
 * The load-bearing test here is the FIRST one. Level 0 must be byte-identical
 * to the pre-noise dataset, because every scenario expectation, the S0
 * regression that protects the false-positive claim, and the reproducibility
 * guarantee were all written against it. If level 0 drifts, none of those are
 * evidence about the same thing any more.
 */

const SEED = "vigil-2026";
const START_MS = Date.parse("2026-09-07T14:30:00+08:00");

function timelineAt(level: NoiseLevel | undefined, seed = SEED): BuiltEvent[] {
  const world = buildWorld(seed);
  const rng = makeRng(seed);
  return buildTimeline({
    world,
    courier: world.couriers[0],
    parcel: world.parcels[0],
    startMs: START_MS,
    rng,
    idPrefix: "noise-test",
    noiseLevel: level,
  });
}

/** Many independent shipments at one level, for the distributional assertions. */
function sample(level: NoiseLevel, count: number): BuiltEvent[][] {
  return Array.from({ length: count }, (_, i) => timelineAt(level, `${SEED}-sample-${i}`));
}

function signals(built: BuiltEvent) {
  const s = vigilSignalsOf(built.event);
  if (!s) throw new Error("every generated event carries signals");
  return s;
}

describe("level 0 is the control", () => {
  it("is byte-identical to a timeline built with no noise argument at all", () => {
    expect(JSON.stringify(timelineAt(0))).toBe(JSON.stringify(timelineAt(undefined)));
  });

  it("leaves every scenario's events untouched", () => {
    const base = buildScenario("S0", {
      world: buildWorld(SEED),
      rng: makeRng(SEED),
      startMs: START_MS,
    });
    const explicit = buildScenario("S0", {
      world: buildWorld(SEED),
      rng: makeRng(SEED),
      startMs: START_MS,
      noiseLevel: 0,
    });

    expect(JSON.stringify(explicit.timeline)).toBe(JSON.stringify(base.timeline));
    expect(JSON.stringify(explicit.warmup)).toBe(JSON.stringify(base.warmup));
  });
});

describe("reproducibility", () => {
  it("produces the same bytes from the same seed at every level", () => {
    for (const level of NOISE_LEVELS) {
      expect(JSON.stringify(timelineAt(level)), `level ${level}`).toBe(
        JSON.stringify(timelineAt(level)),
      );
    }
  });

  it("actually changes the data above level 0", () => {
    expect(JSON.stringify(timelineAt(3))).not.toBe(JSON.stringify(timelineAt(0)));
  });
});

describe("the environment gets worse with the level, and only that", () => {
  /**
   * Monotonicity is a property we ASSERT ABOUT THE GENERATOR, not a claim about
   * real fleets — the same standing as the carefulness ladder's monotonicity.
   * It is here so a future edit cannot make level 2 quietly gentler than
   * level 1 while the experiment tables still read as a curve.
   */
  it("reports worse GPS accuracy on average as the level rises", () => {
    const means = NOISE_LEVELS.map((level) => {
      const values = sample(level, 40)
        .flat()
        .map((b) => signals(b).gps?.point.accuracyMeters ?? 0);
      return values.reduce((a, b) => a + b, 0) / values.length;
    });

    for (let i = 1; i < means.length; i++) {
      expect(means[i], `level ${i} vs ${i - 1}: ${means.join(", ")}`).toBeGreaterThan(means[i - 1]);
    }
  });

  it("waits longer to upload on average as the level rises", () => {
    const means = NOISE_LEVELS.map((level) => {
      const values = sample(level, 40)
        .flat()
        .map((b) => Math.abs(Date.parse(b.event.recordTime!) - Date.parse(b.event.eventTime)) / 1000);
      return values.reduce((a, b) => a + b, 0) / values.length;
    });

    for (let i = 1; i < means.length; i++) {
      expect(means[i], `level ${i} vs ${i - 1}: ${means.join(", ")}`).toBeGreaterThan(means[i - 1]);
    }
  });
});

describe("the distributions straddle the rules rather than sitting under them", () => {
  /**
   * CLAUDE.md rule 2b, asserted rather than promised.
   *
   * The reported accuracy is a confidence radius, not a measurement of the
   * fix's own error. If every generated fix were inside its own stated
   * accuracy, the location rules could never be wrong about an honest scan and
   * the false-positive number would be a floor again — in a new file.
   */
  it("puts some fixes further from the truth than they claim to be", () => {
    const world = buildWorld(SEED);
    let inside = 0;
    let outside = 0;

    for (let i = 0; i < 120; i++) {
      const rng = makeRng(`${SEED}-straddle-${i}`);
      const parcel = world.parcels[i % world.parcels.length];
      const legs = buildTimeline({
        world,
        courier: world.couriers[0],
        parcel,
        startMs: START_MS,
        rng,
        idPrefix: `straddle-${i}`,
        noiseLevel: 2,
      });

      for (const built of legs) {
        if (built.leg !== "delivery") continue;
        const gps = signals(built).gps;
        if (!gps) continue;
        // The recorded address is the truth here: no correction episode moved
        // it, and the natural jitter is small next to the drawn error.
        const metres = haversine(gps.point, parcel.recipientPoint);
        if (metres > (gps.point.accuracyMeters ?? 0)) outside++;
        else inside++;
      }
    }

    expect(inside).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
  });
});

describe("episodes", () => {
  it("makes stale recipient channels and degraded attestations reachable honest-world episodes", () => {
    let stale = false;
    let degraded = false;

    for (let i = 0; i < 800 && !(stale && degraded); i++) {
      const seed = `${SEED}-identity-noise-${i}`;
      const world = buildWorld(seed);
      const planned = planShipmentNoise(makeRng(seed), 3)?.episodes;
      const timeline = timelineAt(3, seed);
      const delivery = timeline.find((event) => event.leg === "delivery");
      if (!delivery) continue;

      if (planned?.staleRecipientChannel) {
        stale = true;
        expect(delivery.identity?.otpChallenge?.recipientChannelFingerprint).not.toBe(
          recipientChannelFingerprint(world.parcels[0].recipientPhone),
        );
      }
      if (planned?.attestationDegraded) {
        degraded = true;
        expect(signals(delivery).integrity?.deviceRecognitionVerdicts).toEqual([
          "MEETS_BASIC_INTEGRITY",
        ]);
      }
    }

    expect(stale, "the stale recipient-channel episode must be reachable").toBe(true);
    expect(degraded, "the attestation downgrade episode must be reachable").toBe(true);
  });

  it("draws the missed scan uniformly across the four skippable legs", () => {
    // H1 fires on exactly ONE of these four gaps. Preferring it would
    // manufacture H1; avoiding it would hide H1. See lib/generate/noise.ts.
    const seen = new Set<string>();
    const present = new Set<string>();

    for (let i = 0; i < 400; i++) {
      const legs = timelineAt(3, `${SEED}-miss-${i}`).map((b) => b.leg);
      for (const name of SKIPPABLE_LEGS) {
        present.add(name);
        if (!legs.includes(name)) seen.add(name);
      }
    }

    expect([...present].sort()).toEqual([...SKIPPABLE_LEGS].sort());
    expect([...seen].sort(), "every skippable leg must be reachable").toEqual(
      [...SKIPPABLE_LEGS].sort(),
    );
  });

  it("gives a redelivery its own eventID, so it is not a replay", () => {
    let found = 0;

    for (let i = 0; i < 200 && found < 3; i++) {
      const legs = timelineAt(3, `${SEED}-redeliver-${i}`);
      if (!legs.some((b) => b.leg === "delivery_attempt")) continue;
      found++;

      const ids = legs.map((b) => b.event.eventID);
      expect(new Set(ids).size, "a repeated leg must not reuse an eventID").toBe(ids.length);
      // The attempt carries no proof of delivery: nobody was in.
      const attempt = legs.find((b) => b.leg === "delivery_attempt")!;
      expect(signals(attempt).pod).toBeUndefined();
    }

    expect(found, "the redelivery episode must be reachable").toBeGreaterThan(0);
  });
});

describe("battery", () => {
  /**
   * Session 6's lesson, kept under noise. A random wobble that lets a handset
   * gain charge between two scans is not noise, it is the shape of the
   * contradiction I14 exists to catch — so the generator would be manufacturing
   * it. A level that RISES is allowed only where the world says why: the device
   * was on charge, or it is a different device.
   */
  it("never rises within a shift unless the device was charging or was swapped", () => {
    for (let i = 0; i < 150; i++) {
      const legs = timelineAt(3, `${SEED}-battery-${i}`);

      for (let leg = 1; leg < legs.length; leg++) {
        const before = signals(legs[leg - 1]);
        const after = signals(legs[leg]);
        if ((after.battery?.levelPercent ?? 0) <= (before.battery?.levelPercent ?? 0)) continue;

        const explained =
          before.battery?.charging === true ||
          after.battery?.charging === true ||
          before.deviceId !== after.deviceId ||
          // A shift boundary, which predates the noise model: `batteryFor`
          // treats the depot legs as the tail of the previous day and starts
          // the delivery round on a fresh charge. A rise there is the model
          // saying the handset was charged between shifts, not a wobble.
          shiftOf(legs, leg) !== shiftOf(legs, leg - 1);

        expect(
          explained,
          `seed ${i}, ${legs[leg - 1].leg} -> ${legs[leg].leg}: battery rose with nothing in the world to explain it`,
        ).toBe(true);
      }
    }
  });
});

describe("a scenario's statement survives the weather", () => {
  it("keeps S6's declared fix exactly as the scenario wrote it", () => {
    const world = buildWorld(SEED);
    const noisy = buildScenario("S6", {
      world,
      rng: makeRng(SEED),
      startMs: START_MS,
      noiseLevel: 3,
    });

    const delivery = noisy.timeline.find((b) => b.leg === "delivery")!;
    const gps = signals(delivery).gps!;

    // S6 IS the degraded-fix scenario. If the environment blurred it further,
    // the control would stop being the control.
    expect(gps.point.accuracyMeters).toBe(140);
    expect(signals(delivery).cell).toBeUndefined();
  });
});

/**
 * Which shift a leg belongs to, counted from the first scan in the timeline.
 *
 * The generator's battery model runs two shifts a day — the depot legs are the
 * tail of one, the delivery round is the start of the next — so a rise ACROSS a
 * boundary is the handset being charged between shifts. Derived from the
 * timestamps rather than the leg names, because a missed scan can put any pair
 * of legs either side of the boundary.
 */
function shiftOf(legs: BuiltEvent[], index: number): number {
  const minutes = (Date.parse(legs[index].event.eventTime) - Date.parse(legs[0].event.eventTime)) / 60_000;
  const day = Math.floor(minutes / 1440);
  const withinDay = minutes - day * 1440;
  // The round starts at 1155; the tolerance absorbs the handset's clock offset,
  // which is minutes at most and never near the two-hour gap either side.
  return day * 2 + (withinDay >= 1100 ? 1 : 0);
}

/** Metres between two points. Local to the test; the engine has its own. */
function haversine(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

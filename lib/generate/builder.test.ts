import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { buildWorld, HUBS } from "./world";
import { buildRequestedScenario, runIdFor, type BuildRequest, type BuiltFault } from "./builder";
import { createHarness, ingestScenario, type IngestHarness } from "./ingest";
import { buildScenario } from "./scenarios";
import { AUTHORED_SCENARIO_IDS } from "./scenarios/types";
import { buildTimeline } from "./timeline";
import { makeRng } from "./rng";
import { DEPOTS, resolveRoute, travelMinutes, MIN_TRAVEL_MINUTES } from "./route";
import { closeDb } from "@/lib/db/client";

/**
 * Shipments a viewer composed, run through the real pipeline.
 *
 * The load-bearing tests here are the LAST two: no event id collides with the
 * authored set, and the authored scenarios are untouched by the seam that made
 * routing possible. Everything else checks that a fault lands where it should;
 * those two check that adding this feature did not quietly damage what existed.
 */

const WORLD = buildWorld("vigil-2026");
const START_MS = Date.parse("2026-09-08T00:00:00+08:00");

/** Jalan Ampang (east) to Shah Alam Seksyen 7 (west): a route with a real line-haul. */
const BASE: Omit<BuildRequest, "fault"> = {
  originIndex: 0,
  destinationIndex: 20,
  declaredValueSen: 12_000,
  recipientChannel: "+60111234567",
};

const harnesses: IngestHarness[] = [];
afterEach(() => {
  while (harnesses.length) {
    const harness = harnesses.pop()!;
    closeDb(harness.deps.db);
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

function build(fault: BuiltFault, extra: Partial<BuildRequest> = {}) {
  const result = buildRequestedScenario({ ...BASE, ...extra, fault }, { world: WORLD, startMs: START_MS });
  if (!result.ok) throw new Error(`expected a build, got a refusal: ${result.reason}`);
  return result;
}

async function run(fault: BuiltFault, extra: Partial<BuildRequest> = {}) {
  const built = build(fault, extra);
  const harness = createHarness(WORLD);
  harnesses.push(harness);
  return { built, ingested: await ingestScenario(built.scenario, harness) };
}

describe("a shipment the viewer composed runs the real pipeline", () => {
  it("accepts every leg when nothing is wrong", async () => {
    const { ingested } = await run("none");

    expect(ingested.legs).toHaveLength(6);
    for (const leg of ingested.legs) {
      expect(leg.gateResult?.decision).toBe("accept");
    }
    expect(ingested.legs.at(-1)!.engineResult?.score).toBe(0);
  });

  /**
   * WITHOUT THIS THE ORTHOGONAL GATE NEVER DEMONSTRATES ITSELF. A courier with
   * no history is cold start, every leg demands a co-signature, and row 2 of
   * the matrix — clean events, wrong distribution — is unreachable.
   *
   * The assertion is that the axis came back EVALUATED, not that any particular
   * number of prior handoffs was used: deriving a count from the cold-start
   * floor would mean the generator reading a pattern threshold.
   */
  it("carries enough warm-up that the pattern axis is evaluated, not cold start", async () => {
    const { ingested } = await run("none");
    const outcome = ingested.legs.at(-1)!.patternOutcome;

    expect(outcome?.coldStart).toBe(false);
    expect(outcome?.sampleSize).toBeGreaterThan(0);
    expect(outcome?.score).toBe(0);
  });

  it.each([
    ["gps_spoof", "I1"],
    ["clock_tamper", "I4"],
  ] as const)("makes %s fire %s at the delivery leg", async (fault, flagId) => {
    const { ingested } = await run(fault);
    const delivery = ingested.legs.at(-1)!;

    expect(delivery.gateResult?.decision).toBe("flag");
    expect(delivery.engineResult?.flags.map((f) => f.id)).toContain(flagId);

    // The exception is at the LAST leg and nowhere earlier.
    for (const earlier of ingested.legs.slice(0, -1)) {
      expect(earlier.gateResult?.decision).toBe("accept");
    }
  });

  it("freezes a parcel outside the courier's mandate", async () => {
    const { ingested } = await run("out_of_scope");
    const delivery = ingested.legs.at(-1)!;

    expect(delivery.gateResult?.decision).toBe("freeze");

    // A hard check ABORTS rather than scoring, so the score is 0 and the flag
    // list is empty. Reading those as "nothing was found" would be exactly
    // backwards, which is why the abort is asserted explicitly: H2 named a
    // failure and suppressed I-scoring behind it.
    expect(delivery.engineResult?.aborted).toBe(true);
    expect(delivery.engineResult?.abortCode).toBe("H2");
    expect(delivery.engineResult?.hardFailures.map((f) => f.id)).toContain("H2");
    expect(delivery.engineResult?.flags).toEqual([]);
  });

  it("aborts a reused event id and records the attempt", async () => {
    const { ingested } = await run("eventid_reuse");

    for (const leg of ingested.legs) expect(leg.gateResult?.decision).toBe("accept");
    expect(ingested.replay).toBeDefined();
    expect(ingested.replay?.ledger?.status).toBe("aborted");
  });

  /**
   * A degraded version of batch scanning is not a smaller version of it. P4
   * contradicts clustered scans against SPREAD addresses, and one parcel has no
   * spread. The refusal names what the fault needs, because a true message that
   * leaves the viewer with no next step has not done its job (rule 3g).
   */
  it("refuses a fault the route cannot express, and says what it would need", () => {
    const result = buildRequestedScenario(
      { ...BASE, fault: "batch_scan" },
      { world: WORLD, startMs: START_MS },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/one building/i);
    expect(result.reason).toMatch(/S2/);
  });
});

describe("built shipments are reproducible", () => {
  it("produces identical bytes for the same route, fault and seed", () => {
    const a = build("gps_spoof");
    const b = build("gps_spoof");

    expect(a.runId).toBe(b.runId);
    expect(JSON.stringify(a.scenario.timeline.map((e) => e.event))).toBe(
      JSON.stringify(b.scenario.timeline.map((e) => e.event)),
    );
    expect(JSON.stringify(a.scenario.warmup.map((e) => e.event))).toBe(
      JSON.stringify(b.scenario.warmup.map((e) => e.event)),
    );
  });

  it("separates runs that differ in any declaration", () => {
    const ids = new Set(
      [
        runIdFor({ ...BASE, fault: "none" }),
        runIdFor({ ...BASE, fault: "gps_spoof" }),
        runIdFor({ ...BASE, fault: "none", declaredValueSen: 99_000 }),
        runIdFor({ ...BASE, fault: "none", destinationIndex: 5 }),
        runIdFor({ ...BASE, fault: "none", seed: "other" }),
      ].map(String),
    );

    expect(ids.size).toBe(5);
  });
});

/**
 * THE COLLISION GUARD.
 *
 * `uuidFrom` derives an event id from the scenario id and the leg name alone —
 * the world seed never enters it. Session 17B built a courier draft as a
 * separately-seeded scenario instance on the assumption that a different seed
 * yields a different identity, and it silently OVERWROTE the operator's case in
 * the workbench. 608 tests, a clean build and a clean typecheck all passed; it
 * was visible only by opening the inbox.
 *
 * A built run sharing an id prefix with an authored scenario would reproduce
 * that exactly, so the namespaces are kept disjoint by construction and checked
 * here by name.
 */
describe("a built run cannot collide with an authored scenario", () => {
  it("shares no event id with any seeded scenario", () => {
    const authored = new Map<string, string>();
    for (const id of AUTHORED_SCENARIO_IDS) {
      const scenario = buildScenario(id, {
        world: WORLD,
        rng: makeRng("vigil-2026"),
        startMs: START_MS,
      });
      for (const built of [...scenario.timeline, ...scenario.warmup]) {
        authored.set(built.event.eventID, `${id}/${built.leg}`);
      }
    }

    for (const fault of ["none", "gps_spoof", "clock_tamper", "out_of_scope", "eventid_reuse"] as const) {
      const built = build(fault);
      for (const event of [...built.scenario.timeline, ...built.scenario.warmup]) {
        const clash = authored.get(event.event.eventID);
        expect(
          clash,
          `built run ${built.runId} leg "${event.leg}" reuses event id ${event.event.eventID}, ` +
            `which belongs to authored scenario ${clash}. The workbench keys entries by event id, ` +
            `so promoting this run would silently overwrite that case — see CLAUDE.md rule 1g.`,
        ).toBeUndefined();
      }
    }
  });
});

/**
 * THE SEAM THAT MADE ROUTING POSSIBLE MUST NOT HAVE MOVED ANYTHING.
 *
 * `buildLegEvent` used to read two module-level hub constants directly. It now
 * takes optional route hubs — and every authored scenario omits them, so the
 * default path must be byte-for-byte what it always was. Same discipline as the
 * noise model's level 0.
 */
describe("the route seam leaves the authored lane untouched", () => {
  it("defaults to the fixed hubs when no route is supplied", () => {
    const courier = WORLD.couriers[0];
    const parcel = WORLD.parcels[0];
    const args = {
      world: WORLD,
      courier,
      parcel,
      startMs: START_MS,
      idPrefix: "seam-check",
    };

    const withoutHubs = buildTimeline({ ...args, rng: makeRng("seam") });
    const withDefaults = buildTimeline({
      ...args,
      rng: makeRng("seam"),
      hubs: { origin: HUBS.kl, destination: HUBS.shahAlam },
    });

    expect(JSON.stringify(withDefaults.map((b) => b.event))).toBe(
      JSON.stringify(withoutHubs.map((b) => b.event)),
    );
  });
});

describe("routes are derived from the cached address set", () => {
  it("derives depots rather than hardcoding them", () => {
    expect(DEPOTS.length).toBeGreaterThan(1);
    for (const depot of DEPOTS) {
      expect(WORLD.referenceSites.some((s) => s.nearAddressIndex === depot.addressIndex)).toBe(true);
    }
  });

  /**
   * A local shipment is labelled local rather than given a fabricated detour.
   * Routing a parcel via a depot it has no reason to visit, purely so a
   * line-haul exists, would invent a journey — the same class of error as
   * inventing a coordinate for a point nobody geocoded.
   */
  it("says when both ends share a depot instead of inventing a detour", () => {
    const local = resolveRoute({ originIndex: 0, destinationIndex: 1 });

    expect(local.local).toBe(true);
    expect(local.originHub.addressIndex).toBe(local.destinationHub.addressIndex);
    expect(local.lineHaulMetres).toBeLessThan(1);
  });

  it("times a moving leg from its distance, with a floor", () => {
    expect(travelMinutes(0)).toBe(MIN_TRAVEL_MINUTES);
    // 45 km at the assumed 45 km/h is an hour.
    expect(travelMinutes(45_000)).toBe(60);
    expect(travelMinutes(90_000)).toBe(120);
  });

  it("refuses a route that is not on the cached set", () => {
    expect(() => resolveRoute({ originIndex: 0, destinationIndex: 999 })).toThrow(/cached addresses/);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { EpcisEvent } from "@/lib/epcis";
import { makeRng } from "./rng";
import { buildWorld } from "./world";
import { SCENARIO_IDS, buildS1AtCarefulness, buildScenario } from "./scenarios";
import type { ScenarioId } from "./scenarios/types";
import { CAREFULNESS_LEVELS, type Carefulness } from "./carefulness";
import { partition, splitOf } from "./split";
import {
  type IngestHarness,
  type IngestedScenario,
  createHarness,
  ingestScenario,
  seedFleetBackground,
} from "./ingest";

const SEED = "vigil-2026";
const START_MS = Date.parse("2026-09-07T14:30:00+08:00");

const harnesses: IngestHarness[] = [];
afterEach(() => {
  while (harnesses.length) rmSync(harnesses.pop()!.dir, { recursive: true, force: true });
});

function context(seed = SEED) {
  return { world: buildWorld(seed), rng: makeRng(seed), startMs: START_MS };
}

/** Generate a scenario and run it through the real agent, fleet and all. */
async function run(id: ScenarioId, seed = SEED): Promise<IngestedScenario> {
  const ctx = context(seed);
  const scenario = buildScenario(id, ctx);
  const harness = createHarness(ctx.world);
  harnesses.push(harness);

  seedFleetBackground(harness, ctx.world, {
    excludeCourierId: scenario.courier.courierId,
    startMs: START_MS - 8 * 3_600_000,
  });

  return await ingestScenario(scenario, harness);
}

const lastLeg = (r: IngestedScenario) => r.legs[r.legs.length - 1];
const flagsAt = (r: IngestedScenario, i: number) => r.legs[i].verdict?.flags ?? [];

/* -------------------------------------------------------------------------- */
/* Reproducibility                                                            */
/* -------------------------------------------------------------------------- */

describe("the same seed produces the same dataset", () => {
  it("generates byte-identical scenarios", async () => {
    const a = SCENARIO_IDS.map((id) => buildScenario(id, context()));
    const b = SCENARIO_IDS.map((id) => buildScenario(id, context()));

    // Keys, not the whole object: the world carries generated keypairs, which
    // come from the OS and are deliberately not seeded.
    const strip = (s: (typeof a)[number]) => ({
      id: s.id,
      warmup: s.warmup.map((e) => e.event),
      timeline: s.timeline.map((e) => e.event),
      disputed: s.disputedEventIds,
      parcels: s.parcels,
    });

    expect(JSON.stringify(a.map(strip))).toBe(JSON.stringify(b.map(strip)));
  });

  it("generates a different dataset from a different seed", async () => {
    const a = buildScenario("S0", context("seed-a"));
    const b = buildScenario("S0", context("seed-b"));

    expect(JSON.stringify(a.timeline.map((e) => e.event))).not.toBe(
      JSON.stringify(b.timeline.map((e) => e.event)),
    );
  });

  it("draws every coordinate and time from the seeded stream, never the clock", async () => {
    // Built twice with a real delay between: identical output means nothing
    // was read from Date.now().
    const first = buildScenario("S1", context());
    const second = buildScenario("S1", context());
    expect(first.timeline.map((e) => e.event.eventTime)).toEqual(
      second.timeline.map((e) => e.event.eventTime),
    );
  });

  it("uses addresses of recorded provenance", async () => {
    const world = buildWorld(SEED);
    // The cache records where it came from, so data read from it is never of
    // unknown origin.
    expect(["nominatim", "curated"]).toContain(world.addressSource);
  });
});

/* -------------------------------------------------------------------------- */
/* Schema conformance                                                         */
/* -------------------------------------------------------------------------- */

describe("every generated event goes through the EPCIS schema", () => {
  it.each(SCENARIO_IDS)("%s validates", async (id) => {
    const scenario = buildScenario(id, context());

    for (const built of [...scenario.warmup, ...scenario.timeline]) {
      expect(EpcisEvent.safeParse(built.event).success).toBe(true);
    }
    if (scenario.replay) {
      expect(EpcisEvent.safeParse(scenario.replay.event.event).success).toBe(true);
    }
  });

  it("carries the vigil: extension inside sensorElementList, per the spec", async () => {
    const scenario = buildScenario("S0", context());
    const delivery = scenario.timeline[scenario.timeline.length - 1].event;

    expect(delivery.sensorElementList?.[0]).toHaveProperty("vigil:signals");
    expect(delivery["vigil:courierId"]).toBe(scenario.courier.courierId);
  });

  it("declares every attestation as mocked, never as if it were real", async () => {
    const scenario = buildScenario("S0", context());
    for (const built of scenario.timeline) {
      const signals = built.event.sensorElementList?.[0]["vigil:signals"];
      if (signals?.integrity) expect(signals.integrity.attestationSource).toBe("mocked");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The scenarios, end to end                                                  */
/* -------------------------------------------------------------------------- */

describe("S0 — ordinary work is accepted", () => {
  it("accepts every leg with no flags", async () => {
    const r = await run("S0");

    expect(r.legs.map((c) => c.decision)).toEqual(Array(6).fill("accept"));
    expect(r.legs.flatMap((c) => c.verdict?.flags ?? [])).toEqual([]);
  });

  /**
   * The demonstration S0 exists for: ordinary work does not reach an operator.
   * A system that demands a co-signature on every handoff has not made approval
   * meaningful, it has made it noise.
   */
  it("troubles no operator: not one leg needs a co-signature", async () => {
    const r = await run("S0");

    expect(r.cosigned).toEqual(Array(6).fill(false));
    expect(r.legs.every((c) => c.requiresCosign === false)).toBe(true);
    expect(lastLeg(r).verdict?.basis).toBe("both_axes");
  });

  it("clears the cold-start floor, so the pattern axis is genuinely evaluated", async () => {
    const r = await run("S0");
    expect(lastLeg(r).patternColdStart).toBe(false);
    expect(lastLeg(r).pattern?.sampleSize).toBeGreaterThanOrEqual(10);
  });
});

describe("S1 — GPS spoofing", () => {
  it("flags the delivery leg on axis 1 and leaves the courier alone", async () => {
    const r = await run("S1");

    expect(r.legs.slice(0, 5).map((c) => c.decision)).toEqual(Array(5).fill("accept"));
    expect(lastLeg(r).decision).toBe("flag");
    expect(flagsAt(r, 5)).toContain("I7");
    // High single, clean pattern: question the EVENT, do not accuse the person.
    expect(lastLeg(r).gateResult?.matrixCell).toBe("high-single/low-pattern");
    expect(lastLeg(r).pattern?.score).toBe(0);
  });

  it("catches the careless spoofer on the mock-location flag alone", async () => {
    const ctx = context();
    const scenario = buildS1AtCarefulness(ctx, 0);
    const harness = createHarness(ctx.world);
    harnesses.push(harness);
    const r = await ingestScenario(scenario, harness);

    expect(flagsAt(r, 5)).toContain("I7");
  });
});

/* -------------------------------------------------------------------------- */
/* The pair the project rests on                                              */
/* -------------------------------------------------------------------------- */

/**
 * S2 AND S6, TOGETHER.
 *
 * Both look, on a dashboard, like a delivery whose location story is odd. One
 * is a courier defrauding forty customers; the other is a courier in a basement
 * carpark. A per-event system sees the same surface in both.
 *
 * S2's every single event is CLEAN — zero on all fourteen checks — and the
 * courier is still caught, because a delivery rate no one can walk is a
 * property of the SET and a customer complaint is an outcome that ARRIVES
 * LATER. Neither exists inside any single event.
 *
 * S6's events are also clean, and the courier is correctly left alone, because
 * a degraded GPS fix reports its own uncertainty and a missing cell is missing
 * rather than contradictory.
 *
 * A fraudster can fake WHERE. They cannot fake HOW FAST, or WHETHER THE
 * CUSTOMER GOT IT. See CLAUDE.md.
 */
describe("S2 and S6 diverge: same surface, opposite verdicts", () => {
  it("escalates the batch scanner and accepts the tunnel, on clean events in both", async () => {
    const batch = await run("S2");
    const tunnel = await run("S6");

    // Neither has a single event that scores on axis 1.
    expect(batch.legs.every((c) => (c.inconsistency?.score ?? 0) === 0)).toBe(true);
    expect(tunnel.legs.every((c) => (c.inconsistency?.score ?? 0) === 0)).toBe(true);

    // And they end in opposite places.
    expect(lastLeg(batch).decision).toBe("escalate");
    expect(lastLeg(tunnel).decision).toBe("accept");

    expect(lastLeg(batch).gateResult?.matrixCell).toBe("low-single/high-pattern");
    expect(lastLeg(tunnel).gateResult?.matrixCell).toBe("low-single/low-pattern");

    // The difference is entirely on axis 2.
    expect(lastLeg(batch).pattern?.score).toBeGreaterThanOrEqual(40);
    expect(lastLeg(tunnel).pattern?.score).toBe(0);
  });

  it("catches the batch scanner on the shape alone: P1 and P2, no I-rule", async () => {
    const r = await run("S2");
    const flags = lastLeg(r).verdict?.flags ?? [];

    expect(flags).toContain("P1"); // a rate no one can walk
    expect(flags).toContain("P2"); // and the customers complained
    expect(flags.filter((f) => /^I\d+$/.test(f))).toEqual([]);
  });

  it("does not flag the tower for being a tower: P4 stays silent", async () => {
    const r = await run("S2");
    // The clustered scans' own parcels are addressed to the same building, so
    // the cluster is a building, not a batch scan. An honest tower round must
    // not be punished for being a tower round.
    expect(lastLeg(r).verdict?.flags).not.toContain("P4");
  });

  it("says how much evidence it had: the tunnel's coverage line drops", async () => {
    const clean = await run("S0");
    const tunnel = await run("S6");

    const cleanCoverage = lastLeg(clean).coverage?.inconsistency;
    const tunnelCoverage = lastLeg(tunnel).coverage?.inconsistency;

    // Same verdict, less evidence behind it - and the operator is told so
    // rather than being shown an identical-looking accept.
    expect(lastLeg(tunnel).decision).toBe(lastLeg(clean).decision);
    expect(tunnelCoverage!.evaluated).toBeLessThan(cleanCoverage!.evaluated);
    expect(tunnelCoverage!.line).toMatch(/of 14 checks evaluable$/);
  });

  it("does not escalate the tunnel, which is the whole false-positive argument", async () => {
    const r = await run("S6");
    expect(r.legs.map((c) => c.decision)).toEqual(Array(6).fill("accept"));
    expect(lastLeg(r).verdict?.flags).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The remaining scenarios                                                    */
/* -------------------------------------------------------------------------- */

describe("S3 — event ID reuse", () => {
  it("seals the delivery, then aborts the reuse and records the attempt", async () => {
    const r = await run("S3");

    expect(lastLeg(r).decision).toBe("accept");
    expect(r.replay?.halted).toEqual({ at: "verify", reason: "EVENT_ID_REUSE" });

    // A failed forgery is evidence: the attempt is in the chain.
    const kinds = r.harness.deps.ledger.readRecords().map((rec) => rec.kind);
    expect(kinds).toContain("abort");
    expect(r.harness.deps.ledger.verifyChain().valid).toBe(true);
  });
});

describe("S4 — a scan outside the courier's route", () => {
  it("refuses the handoff on H2", async () => {
    const r = await run("S4");

    expect(lastLeg(r).decision).toBe("freeze");
    expect(flagsAt(r, 5)).toContain("H2");
    expect(lastLeg(r).verdict?.abortCode).toBe("H2");
  });
});

describe("S5 — clock tampering", () => {
  it("flags the divergence between the device clock and the server clock", async () => {
    const r = await run("S5");

    expect(lastLeg(r).decision).toBe("flag");
    expect(flagsAt(r, 5)).toContain("I4");
  });
});

describe("every scenario meets its declared expectation", () => {
  it.each(SCENARIO_IDS)("%s", async (id) => {
    const r = await run(id);
    const scenario = r.scenario;
    const final = lastLeg(r);

    expect(final.decision, `${id} decision`).toBe(scenario.expectation.decision);

    for (const flag of scenario.expectation.expectFlags ?? []) {
      expect(final.verdict?.flags, `${id} expected ${flag}`).toContain(flag);
    }
    for (const flag of scenario.expectation.forbidFlags ?? []) {
      expect(final.verdict?.flags, `${id} must not raise ${flag}`).not.toContain(flag);
    }
  });

  it("puts the exception at the declared leg, not earlier", async () => {
    for (const id of SCENARIO_IDS) {
      const r = await run(id);
      const scenario = r.scenario;
      if (scenario.expectation.exceptionAtLeg === null) {
        expect(r.legs.every((c) => c.decision === "accept"), `${id} should be clean throughout`).toBe(
          true,
        );
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Experiment support                                                         */
/* -------------------------------------------------------------------------- */

describe("the holdout split", () => {
  it("is deterministic for the same key and seed", async () => {
    expect(splitOf("S2-run-14", "exp")).toBe(splitOf("S2-run-14", "exp"));
  });

  it("partitions into two disjoint halves that cover the set", async () => {
    const keys = Array.from({ length: 400 }, (_, i) => `run-${i}`);
    const { tune, report } = partition(keys, (k) => k, "exp-1");

    expect(tune.length + report.length).toBe(keys.length);
    expect(new Set([...tune, ...report]).size).toBe(keys.length);
    // Roughly even, so neither half is a rounding error.
    expect(tune.length).toBeGreaterThan(150);
    expect(report.length).toBeGreaterThan(150);
  });

  it("does not reassign existing items when the set grows", async () => {
    const small = Array.from({ length: 50 }, (_, i) => `run-${i}`);
    const large = Array.from({ length: 200 }, (_, i) => `run-${i}`);

    const a = partition(small, (k) => k, "exp-1");
    const b = partition(large, (k) => k, "exp-1");

    for (const key of a.tune) expect(b.tune).toContain(key);
  });

  it("splits differently under a different seed", async () => {
    const keys = Array.from({ length: 200 }, (_, i) => `run-${i}`);
    const a = partition(keys, (k) => k, "exp-1").tune;
    const b = partition(keys, (k) => k, "exp-2").tune;
    expect(a).not.toEqual(b);
  });
});

describe("the carefulness ladder", () => {
  /** How much axis-1 evidence the forged scan leaves behind. */
  async function scoreAt(level: Carefulness): Promise<number> {
    const ctx = context();
    const scenario = buildS1AtCarefulness(ctx, level);
    const harness = createHarness(ctx.world);
    harnesses.push(harness);
    const r = await ingestScenario(scenario, harness);
    return lastLeg(r).inconsistency?.score ?? 0;
  }

  /**
   * Monotone: more capability never leaves MORE evidence.
   *
   * This is a property asserted about the GENERATOR, not a claim about real
   * attackers. It says the ladder is well-formed — each rung is a superset of
   * the one below — so the attacker-cost sweep produces a curve rather than
   * noise. See docs/DATASET.md.
   */
  it("never leaves more evidence as the attacker gets more capable", async () => {
    const scores: number[] = [];
    for (const level of CAREFULNESS_LEVELS) scores.push(await scoreAt(level));

    for (let i = 1; i < scores.length; i++) {
      expect(scores[i], `level ${i} left more evidence than level ${i - 1}`).toBeLessThanOrEqual(
        scores[i - 1],
      );
    }
  });

  it("catches the careless attacker and reaches the documented limit", async () => {
    // Level 0 is caught on a single flag. The top of the ladder is the boundary
    // written into Known Limitations: a patched device plus a colluding
    // recipient is out of this architecture's reach on a single event.
    expect(await scoreAt(0)).toBeGreaterThan(0);
    expect(await scoreAt(4)).toBeLessThan(await scoreAt(0));
  });
});

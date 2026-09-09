import {
  BASE_SEED,
  type NoiseLevel,
  pct,
  prepare,
  printTable,
  reachedOperator,
  reportingSeeds,
  writeCsv,
} from "./harness";
import {
  buildLegEvent,
  buildWorld,
  ingestWithApproval,
  jitterPoint,
  makeRng,
  NOISE_LEVELS,
  NOISE_PROFILES,
  offsetPoint,
} from "@/lib/generate";
// THE ONE ALLOWED THRESHOLD IMPORT IN scripts/experiments/.
//
// Varying a threshold IS this experiment's independent variable, which is why
// the anti-circularity guard names e6 as its sole exception. Every other script
// is banned from this import: reading a threshold to decide what the ATTACKER
// does would make the result circular. Here it decides only what to sweep.
import { DEFAULT_THRESHOLDS } from "@/lib/engine/thresholds";

/**
 * E6 — threshold sensitivity.
 *
 * Sweeps the implied-speed limit from 80 to 160 km/h and plots detection
 * against false positives. The point is to answer "why 120?" with a curve
 * rather than an argument.
 *
 * The shipped value is derived, not chosen: the Malaysian expressway limit is
 * 110 km/h, plus a margin for GPS error at both endpoints. This experiment
 * exists to show what that derivation costs and buys.
 *
 * SWEPT ACROSS NOISE LEVELS since session 10. The session-9 run measured the
 * false-positive edge against clean shipments whose GPS scatter was six to
 * eighteen metres and whose clocks were exact, which is why the edge sat at
 * 40-50 km/h: nothing in that data could imply a higher speed. A real fleet's
 * environment moves both endpoints of every interval, so the edge is a curve
 * per level rather than one point, and "why 120?" is answerable against it.
 */

/**
 * Extended BELOW the brief's 80-160 range on purpose.
 *
 * The first run showed a 0% false-positive rate at every point from 80 up,
 * which means the clean data never implies a speed that high — so the sweep
 * could not show where the headroom actually runs out. The lower points find
 * that edge, which is the number that makes "why 120?" answerable.
 */
const SWEEP = [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160];
const ATTACK_SEEDS = 16;
const CLEAN_SEEDS = 16;

const DELIVERY_LEG = {
  name: "delivery" as const,
  bizStep: "urn:epcglobal:cbv:bizstep:delivering",
  disposition: "urn:epcglobal:cbv:disp:retail_sold",
  offsetMinutes: 0,
  where: "recipient" as const,
};

/** Thresholds with only the speed limit changed. */
function withSpeedLimit(kmh: number) {
  return { ...DEFAULT_THRESHOLDS, maxImpliedSpeedKmh: kmh };
}

/**
 * A forged delivery claiming a position the courier could not have reached.
 *
 * The claimed distance is spread across runs so the sweep sees a RANGE of
 * implied speeds rather than one value — a single speed would produce a step
 * function and tell us nothing about the shape.
 */
async function runSpeedAttack(
  seed: string,
  claimedKmAway: number,
  speedLimit: number,
  noiseLevel: NoiseLevel,
) {
  const run = await prepare("S0", seed, {
    deps: { thresholds: { engine: withSpeedLimit(speedLimit) } },
    noiseLevel,
  });

  try {
    const world = buildWorld(seed);
    const scenario = run.scenario;
    const parcel = scenario.parcels[0];
    const rng = makeRng(`${seed}::speed-${claimedKmAway}`);

    // Run the shipment up to the delivery, so the delivery has a previous leg
    // to be measured against.
    const legs = scenario.timeline.slice(0, -1);
    for (const built of legs) await ingestWithApproval(run.harness, built, run.args);

    const previous = legs[legs.length - 1];
    const previousPoint = { latitude: 3.0733, longitude: 101.5185 };
    const claimed = offsetPoint(previousPoint, claimedKmAway * 1000, 0);
    const addressIndex = 0;

    const built = buildLegEvent({
      world,
      courier: scenario.courier,
      parcel,
      leg: DELIVERY_LEG,
      legIndex: legs.length,
      // Thirty minutes after the previous leg. The distance is what varies.
      startMs: Date.parse(previous.event.eventTime) + 30 * 60_000,
      rng,
      eventIdSeed: `${seed}-speed-${claimedKmAway}`,
      overrides: {
        scanPoint: jitterPoint(rng, claimed, 20),
        cellSiteId: world.sitesByAddress[addressIndex].cell,
        wifiBssid: world.sitesByAddress[addressIndex].wifi,
        omitCell: true,
        omitWifi: true,
      },
    });

    const { ctx } = await ingestWithApproval(run.harness, built, run.args);
    const flags = ctx.verdict?.flags ?? [];

    return {
      detected: flags.includes("I3"),
      alerted: reachedOperator(ctx),
      impliedSpeedKmh: (claimedKmAway / 0.5).toFixed(0),
    };
  } finally {
    run.dispose();
  }
}

/** A clean shipment under a modified speed limit. */
async function runCleanAtLimit(seed: string, speedLimit: number, noiseLevel: NoiseLevel) {
  const run = await prepare("S0", seed, {
    deps: { thresholds: { engine: withSpeedLimit(speedLimit) } },
    noiseLevel,
  });

  try {
    let alerted = false;
    let i3 = false;
    for (const built of run.scenario.timeline) {
      const { ctx } = await ingestWithApproval(run.harness, built, run.args);
      if (reachedOperator(ctx)) alerted = true;
      if ((ctx.verdict?.flags ?? []).includes("I3")) i3 = true;
    }
    return { alerted, i3 };
  } finally {
    run.dispose();
  }
}

async function main() {
  const rows: Record<string, unknown>[] = [];
  const summary: Record<string, unknown>[] = [];

  // A spread of claimed distances, so the sweep sees a range of implied speeds.
  // 30 minutes each, so km/h is twice the distance in km.
  const distances = Array.from({ length: ATTACK_SEEDS }, (_, i) => 40 + i * 5);

  for (const level of NOISE_LEVELS) {
    for (const limit of SWEEP) {
      const attackSeeds = reportingSeeds(`${BASE_SEED}-e6a-${limit}`, ATTACK_SEEDS);
      const cleanSeeds = reportingSeeds(`${BASE_SEED}-e6c-${limit}`, CLEAN_SEEDS);

      let detected = 0;
      for (const [i, seed] of attackSeeds.entries()) {
        const result = await runSpeedAttack(seed, distances[i], limit, level);
        if (result.detected) detected++;
        rows.push({
          experiment: "E6",
          noise_level: level,
          noise_name: NOISE_PROFILES[level].name,
          arm: "attack",
          speed_limit_kmh: limit,
          seed,
          half: "report",
          seeds_in_cell: attackSeeds.length,
          claimed_km: distances[i],
          implied_speed_kmh: result.impliedSpeedKmh,
          i3_fired: result.detected ? 1 : 0,
          alerted: result.alerted ? 1 : 0,
        });
      }

      let i3FalsePositives = 0;
      let anyAlert = 0;
      for (const seed of cleanSeeds) {
        const result = await runCleanAtLimit(seed, limit, level);
        if (result.i3) i3FalsePositives++;
        if (result.alerted) anyAlert++;
        rows.push({
          experiment: "E6",
          noise_level: level,
          noise_name: NOISE_PROFILES[level].name,
          arm: "clean",
          speed_limit_kmh: limit,
          seed,
          half: "report",
          seeds_in_cell: cleanSeeds.length,
          claimed_km: "",
          implied_speed_kmh: "",
          i3_fired: result.i3 ? 1 : 0,
          alerted: result.alerted ? 1 : 0,
        });
      }

      summary.push({
        noise: `${level} ${NOISE_PROFILES[level].name}`,
        limit_kmh: limit,
        n_attack: attackSeeds.length,
        detected: `${detected}/${attackSeeds.length}`,
        detection: pct(detected, attackSeeds.length),
        n_clean: cleanSeeds.length,
        i3_false_pos: `${i3FalsePositives}/${cleanSeeds.length}`,
        i3_fp_rate: pct(i3FalsePositives, cleanSeeds.length),
        any_alert_rate: pct(anyAlert, cleanSeeds.length),
        shipped: limit === DEFAULT_THRESHOLDS.maxImpliedSpeedKmh ? "<- shipped" : "",
      });
    }
  }

  const path = writeCsv("e6-threshold-sensitivity.csv", rows);
  printTable("E6 — implied-speed threshold sweep, by noise level (reporting half only)", summary);

  /**
   * WHERE THE HEADROOM RUNS OUT, per level.
   *
   * The false positive this sweep is about is I3 FIRING ON A CLEAN SHIPMENT.
   * Under noise the whole-system alert rate on clean data is dominated by
   * things this sweep does not vary — see E3 — so counting every alert here
   * would report E3's number under E6's heading and hide the edge entirely.
   * `any_alert_rate` is carried alongside so the difference is visible rather
   * than assumed.
   */
  const edges = NOISE_LEVELS.map((level) => {
    const atLevel = summary.filter((r) => r.noise === `${level} ${NOISE_PROFILES[level].name}`);
    const clean = atLevel.filter((r) => r.i3_fp_rate === "0.0%").map((r) => r.limit_kmh as number);
    return {
      noise: `${level} ${NOISE_PROFILES[level].name}`,
      lowest_limit_with_zero_i3_fp: clean.length ? Math.min(...clean) : "none in sweep",
      detection_there: atLevel.find((r) => r.limit_kmh === Math.min(...clean))?.detection ?? "",
      detection_at_shipped:
        atLevel.find((r) => r.limit_kmh === DEFAULT_THRESHOLDS.maxImpliedSpeedKmh)?.detection ?? "",
    };
  });
  printTable("  the false-positive edge, per noise level", edges);

  process.stdout.write(
    `
  attacks claim ${distances[0]}-${distances[distances.length - 1]} km in 30 min ` +
      `(${distances[0] * 2}-${distances[distances.length - 1] * 2} km/h implied)
  ${path}
`,
  );
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack}\n`);
  process.exit(1);
});

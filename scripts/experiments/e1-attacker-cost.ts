import {
  BASE_SEED,
  START_MS,
  pct,
  prepare,
  printTable,
  reachedOperator,
  reportingSeeds,
  writeCsv,
} from "./harness";
import { CAREFULNESS, CAREFULNESS_LEVELS, type Carefulness } from "@/lib/generate/carefulness";
import { forgedScanOverrides } from "@/lib/generate/carefulness";
import { buildLegEvent, jitterPoint, makeRng } from "@/lib/generate";
import { ingestWithApproval, recordDispute } from "@/lib/generate";
import { ADDRESSES, addressIndexFor, buildWorld } from "@/lib/generate";

/**
 * E1 — attacker cost.
 *
 * How many fake deliveries a fraudster completes before the system stops them,
 * as a function of what they had to acquire to do it.
 *
 * A CURVE, NOT A NUMBER. "We catch fraud" is not a finding. "Here is how far a
 * fraudster gets for each capability they buy, and here is where we stop being
 * able to see them" is.
 *
 * The ladder describes CAPABILITIES — a mock-location app, a rooted handset, a
 * patched build, a colluding recipient. It does not describe which detector
 * each defeats, and this script may not read a threshold.
 */

const MAX_ATTEMPTS = 40;
const SEEDS_PER_LEVEL = 12;

/**
 * How often a customer who did not get their parcel actually calls.
 *
 * An ASSUMPTION, not a measurement — see docs/DATASET.md. Behaviour, not a
 * threshold: it says what recipients do, not what any detector looks for.
 */
const COMPLAINT_RATE = 0.35;

const DELIVERY_LEG = {
  name: "delivery" as const,
  bizStep: "urn:epcglobal:cbv:bizstep:delivering",
  disposition: "urn:epcglobal:cbv:disp:retail_sold",
  offsetMinutes: 0,
  where: "recipient" as const,
};

/** One fraudster, one seed: how many forged deliveries land before they are stopped. */
async function runCampaign(level: Carefulness, seed: string) {
  const profile = CAREFULNESS[level];
  const run = await prepare("S0", seed);

  try {
    const world = buildWorld(seed);
    const courier = run.scenario.courier;
    // Parcels the warm-up did not use, so a forged delivery is a fresh handoff.
    const parcels = world.parcels
      .filter((p) => p.epc.startsWith(`urn:epc:id:sgtin:0614141.${String(100000).padStart(6, "0")}.`))
      .slice(0, MAX_ATTEMPTS);

    let completed = 0;
    let caughtAt: number | null = null;
    let caughtBy: string[] = [];

    for (let i = 0; i < Math.min(MAX_ATTEMPTS, parcels.length); i++) {
      const parcel = parcels[i];
      const rng = makeRng(`${seed}::fraud-${level}-${i}`);

      const addressIndex = addressIndexFor(parcel);
      const consistent = world.sitesByAddress[addressIndex];
      // The courier is actually somewhere else entirely.
      const elsewhere = world.sitesByAddress[(addressIndex + 7) % ADDRESSES.length];

      const built = buildLegEvent({
        world,
        courier,
        parcel,
        leg: DELIVERY_LEG,
        legIndex: i,
        // Twenty minutes apart: a plausible round, not a burst. The fraud here
        // is the location, not the rate.
        startMs: START_MS + i * 20 * 60_000,
        rng,
        eventIdSeed: `${seed}-fraud-${level}-${i}`,
        overrides: forgedScanOverrides(
          profile,
          jitterPoint(rng, parcel.recipientPoint, 20),
          consistent,
          elsewhere,
        ),
      });

      const { ctx } = await ingestWithApproval(run.harness, built, run.args);

      // THE RECIPIENT NEVER GOT THE PARCEL, SO THEY COMPLAIN.
      //
      // Omitted from the first run of this experiment, which made levels 2-4
      // indistinguishable: the ladder defines level 4 as "a recipient who
      // agrees not to complain", which only means anything if the levels below
      // it have recipients who do. Not every non-delivery produces a call, so a
      // fraction of them do.
      if (!profile.recipientColludes && rng.chance(COMPLAINT_RATE)) {
        recordDispute(run.harness, built.event.eventID, parcel.epc);
      }

      if (reachedOperator(ctx)) {
        caughtAt = i + 1;
        caughtBy = ctx.verdict?.flags ?? [];
        break;
      }
      completed++;
    }

    return { completed, caughtAt, caughtBy };
  } finally {
    run.dispose();
  }
}

async function main() {
  const rows: Record<string, unknown>[] = [];
  const summary: Record<string, unknown>[] = [];

  for (const level of CAREFULNESS_LEVELS) {
    const seeds = reportingSeeds(`${BASE_SEED}-e1-${level}`, SEEDS_PER_LEVEL);
    const completions: number[] = [];
    let detected = 0;
    const flagCounts = new Map<string, number>();

    for (const seed of seeds) {
      const result = await runCampaign(level, seed);
      completions.push(result.completed);
      if (result.caughtAt !== null) detected++;
      for (const flag of result.caughtBy) {
        flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1);
      }

      rows.push({
        experiment: "E1",
        level,
        capability: CAREFULNESS[level].capability,
        seed,
        half: "report",
        seeds_in_cell: seeds.length,
        max_attempts: MAX_ATTEMPTS,
        completed_before_caught: result.completed,
        caught_at_attempt: result.caughtAt ?? "",
        detected: result.caughtAt !== null ? 1 : 0,
        flags: result.caughtBy.join(" "),
      });
    }

    const mean = completions.reduce((a, b) => a + b, 0) / completions.length;
    const topFlags = [...flagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, n]) => `${id}×${n}`)
      .join(" ");

    summary.push({
      level,
      n: seeds.length,
      detected: `${detected}/${seeds.length}`,
      detection_rate: pct(detected, seeds.length),
      mean_completed: mean.toFixed(1),
      worst_case: Math.max(...completions),
      caught_by: topFlags || "—",
      capability: CAREFULNESS[level].capability,
    });
  }

  const path = writeCsv("e1-attacker-cost.csv", rows);

  printTable("E1 — attacker cost (reporting half only)", summary);
  process.stdout.write(`\n  n = seeds per level; max ${MAX_ATTEMPTS} forged deliveries per run\n`);
  process.stdout.write(`  ${path}\n`);

  const undetected = summary.filter((s) => s.detected === `0/${s.n}`);
  if (undetected.length > 0) {
    process.stdout.write(
      `\n  MEASURED BOUNDARY: level(s) ${undetected.map((s) => s.level).join(", ")} were not detected in any run.\n` +
        `  Reported as found. Nothing was tuned to change this.\n`,
    );
  }
}

// Not top-level await: tsx compiles these scripts to CJS.
main().catch((err) => {
  process.stderr.write(`${(err as Error).stack}
`);
  process.exit(1);
});

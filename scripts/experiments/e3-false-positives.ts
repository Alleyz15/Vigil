import {
  BASE_SEED,
  type NoiseLevel,
  pct,
  printTable,
  reachedOperator,
  reportingSeeds,
  runFullScenario,
  writeCsv,
  type ScenarioId,
} from "./harness";
import { NOISE_LEVELS, NOISE_PROFILES } from "@/lib/generate";

/**
 * E3 — false positive rate.
 *
 * Clean shipments, across many seeds and across NOISE LEVELS: how often does
 * ordinary work reach an operator? The brief scores "fewer false alerts"
 * explicitly, and a detection rate reported without this number is meaningless
 * — a system that flags everything detects everything.
 *
 * WHY THIS IS A CURVE NOW. Session 9 ran this against a generator whose clean
 * shipments had bounded noise by construction and got 0% across 240 legs. That
 * was a floor, not a rate: it measured "our clean data does not trip our
 * rules". The generator now models a real fleet's environment — degraded fixes,
 * queued uploads, missed scans, stale addresses — at four levels, so the number
 * carries its own sensitivity instead of resting on one assumption.
 *
 * BROKEN DOWN BY ABORT CODE, because CLAUDE.md's Open reservations flags
 * H1 → freeze as a possible over-refusal and this is where that is settled.
 * If H1 dominates, that is REPORTED, not fixed here: changing a threshold in
 * the run that measured it is the circularity the whole discipline exists to
 * prevent.
 *
 * AND BY EPISODE, from the generator's own record of what it drew. Attributing
 * an alert to "the shipment that lost a scan" by looking at the events would
 * mean using the detector's measurement to explain the detector's output.
 */

const CLEAN: { id: ScenarioId; label: string }[] = [
  { id: "S0", label: "Normal delivery" },
  { id: "S6", label: "GPS degradation underground" },
];

const SEEDS_PER_SCENARIO = 120;

/** The episodes an alerted shipment carried, from the generator's own plan. */
const EPISODE_KEYS = [
  "missed_scan",
  "redelivery",
  "address_correction",
  "charged_mid_shift",
  "handset_swap",
] as const;
type EpisodeKey = (typeof EPISODE_KEYS)[number];

type Tally = { shipments: number; alerted: number };
type MissTally = { shipments: number; alerted: number; h1: number };

async function main() {
  const rows: Record<string, unknown>[] = [];
  const summary: Record<string, unknown>[] = [];
  const overall: Record<string, unknown>[] = [];
  const abortByLevel = new Map<NoiseLevel, Map<string, number>>();
  const flagByLevel = new Map<NoiseLevel, Map<string, number>>();
  const episodeByLevel = new Map<NoiseLevel, Map<EpisodeKey, Tally>>();
  /**
   * THE H1 TABLE, measured.
   *
   * CLAUDE.md's session-10 trace predicted, from the custody table alone and
   * before any of this ran, that only ONE of the four missable scans produces
   * an impermissible transition. This is that claim put to the data: which leg
   * a fleet loses, and whether losing it reaches an operator.
   */
  const missedByLeg = new Map<string, MissTally>();

  for (const level of NOISE_LEVELS) {
    const abortCodes = new Map<string, number>();
    const flagCounts = new Map<string, number>();
    const episodes = new Map<EpisodeKey, Tally>(
      EPISODE_KEYS.map((k) => [k, { shipments: 0, alerted: 0 }]),
    );
    abortByLevel.set(level, abortCodes);
    flagByLevel.set(level, flagCounts);
    episodeByLevel.set(level, episodes);

    let levelLegs = 0;
    let levelAlerts = 0;
    let levelShipments = 0;
    let levelShipmentsAlerted = 0;

    for (const scenario of CLEAN) {
      const seeds = reportingSeeds(`${BASE_SEED}-e3-${scenario.id}`, SEEDS_PER_SCENARIO);
      let legs = 0;
      let alerts = 0;
      let shipmentsWithAnyAlert = 0;

      for (const seed of seeds) {
        const run = await runFullScenario(scenario.id, seed, level);
        try {
          let shipmentAlerted = false;
          const drawn = run.scenario.noiseEpisodes;
          const carried: EpisodeKey[] = drawn
            ? [
                ...(drawn.missedLeg ? (["missed_scan"] as const) : []),
                ...(drawn.redelivery ? (["redelivery"] as const) : []),
                ...(drawn.addressCorrection ? (["address_correction"] as const) : []),
                ...(drawn.chargedMidShift ? (["charged_mid_shift"] as const) : []),
                ...(drawn.handsetSwap ? (["handset_swap"] as const) : []),
              ]
            : [];

          for (const ctx of run.legs) {
            legs++;
            if (!reachedOperator(ctx)) continue;

            alerts++;
            shipmentAlerted = true;
            const code = ctx.verdict?.abortCode ?? "(no abort code)";
            abortCodes.set(code, (abortCodes.get(code) ?? 0) + 1);
            for (const flag of ctx.verdict?.flags ?? []) {
              flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1);
            }

            rows.push({
              experiment: "E3",
              noise_level: level,
              noise_name: NOISE_PROFILES[level].name,
              scenario: scenario.id,
              seed,
              half: "report",
              seeds_in_cell: seeds.length,
              leg: ctx.event?.bizStep ?? "",
              decision: ctx.decision ?? "",
              abort_code: ctx.verdict?.abortCode ?? "",
              flags: (ctx.verdict?.flags ?? []).join(" "),
              episodes: carried.join(" "),
              missed_leg: drawn?.missedLeg ?? "",
            });
          }

          if (drawn?.missedLeg) {
            const tally = missedByLeg.get(drawn.missedLeg) ?? {
              shipments: 0,
              alerted: 0,
              h1: 0,
            };
            tally.shipments++;
            if (shipmentAlerted) tally.alerted++;
            if (run.legs.some((c) => c.verdict?.abortCode === "H1")) tally.h1++;
            missedByLeg.set(drawn.missedLeg, tally);
          }

          for (const key of carried) {
            const tally = episodes.get(key)!;
            tally.shipments++;
            if (shipmentAlerted) tally.alerted++;
          }

          if (shipmentAlerted) shipmentsWithAnyAlert++;
        } finally {
          run.dispose();
        }
      }

      levelLegs += legs;
      levelAlerts += alerts;
      levelShipments += seeds.length;
      levelShipmentsAlerted += shipmentsWithAnyAlert;

      summary.push({
        noise: `${level} ${NOISE_PROFILES[level].name}`,
        scenario: scenario.id,
        label: scenario.label,
        seeds: seeds.length,
        legs,
        alerts,
        per_leg: pct(alerts, legs),
        shipments_affected: `${shipmentsWithAnyAlert}/${seeds.length}`,
      });
    }

    overall.push({
      noise: `${level} ${NOISE_PROFILES[level].name}`,
      seeds: levelShipments,
      legs: levelLegs,
      alerts: levelAlerts,
      per_leg: pct(levelAlerts, levelLegs),
      per_shipment: pct(levelShipmentsAlerted, levelShipments),
      top_abort: topOf(abortCodes),
      top_flags: topOf(flagCounts, 3),
    });
  }

  // A clean run still writes a row, so the CSV records the denominator.
  if (rows.length === 0) {
    rows.push({
      experiment: "E3",
      noise_level: "",
      noise_name: "",
      scenario: "(all)",
      seed: "(none alerted)",
      half: "report",
      seeds_in_cell: SEEDS_PER_SCENARIO,
      leg: "",
      decision: "",
      abort_code: "",
      flags: "",
      episodes: "",
      missed_leg: "",
    });
  }

  const path = writeCsv("e3-false-positives.csv", rows);

  printTable("E3 — false positives on clean shipments, by noise level (reporting half only)", summary);
  printTable("  overall, per noise level", overall);

  for (const level of NOISE_LEVELS) {
    const abortCodes = abortByLevel.get(level)!;
    const breakdown = [...abortCodes.entries()].sort((a, b) => b[1] - a[1]);
    const total = breakdown.reduce((sum, [, n]) => sum + n, 0);
    if (breakdown.length === 0) continue;

    printTable(
      `  level ${level} (${NOISE_PROFILES[level].name}) — by abort code`,
      breakdown.map(([code, n]) => ({ abort_code: code, count: n, share: pct(n, total) })),
    );
  }

  for (const level of NOISE_LEVELS) {
    const episodes = episodeByLevel.get(level)!;
    const withAny = [...episodes.entries()].filter(([, t]) => t.shipments > 0);
    if (withAny.length === 0) continue;
    printTable(
      `  level ${level} (${NOISE_PROFILES[level].name}) — alert rate per episode, from the generator's own plan`,
      withAny.map(([key, t]) => ({
        episode: key,
        shipments: t.shipments,
        alerted: t.alerted,
        rate: pct(t.alerted, t.shipments),
      })),
    );
  }

  if (missedByLeg.size > 0) {
    printTable(
      "  which missed scan reaches an operator (all noise levels pooled)",
      [...missedByLeg.entries()]
        .sort((a, b) => b[1].shipments - a[1].shipments)
        .map(([leg, t]) => ({
          missed_leg: leg,
          shipments: t.shipments,
          alerted: t.alerted,
          h1_freeze: t.h1,
          rate: pct(t.alerted, t.shipments),
        })),
    );
  }

  // THE H1 RESERVATION, settled or not, in the run that measured it.
  const h1 = NOISE_LEVELS.map((level) => {
    const codes = abortByLevel.get(level)!;
    const total = [...codes.values()].reduce((a, b) => a + b, 0);
    return { level, count: codes.get("H1") ?? 0, total };
  });
  const dominates = h1.some((h) => h.total > 0 && h.count / h.total > 0.5);
  const fired = h1.some((h) => h.count > 0);

  process.stdout.write(
    `\n  H1: ${h1.map((h) => `L${h.level} ${h.count}/${h.total || 0}`).join("  ")}\n`,
  );
  if (dominates) {
    process.stdout.write(
      "\n  H1 DOMINATES. Reported, not fixed: changing a threshold in the run that\n" +
        "  measured it would be circular. That is a separate session and a rerun.\n",
    );
  } else if (fired) {
    process.stdout.write(
      "\n  H1 fired and did NOT dominate. The reservation can close on this evidence.\n",
    );
  } else {
    process.stdout.write(
      "\n  H1 never fired, even with missed scans in the data. Report why, do not tune.\n",
    );
  }

  process.stdout.write(`  ${path}\n`);
}

function topOf(counts: Map<string, number>, take = 1): string {
  return (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, take)
      .map(([id, n]) => `${id}×${n}`)
      .join(" ") || "—"
  );
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack}\n`);
  process.exit(1);
});

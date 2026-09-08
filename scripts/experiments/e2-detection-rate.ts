import {
  BASE_SEED,
  pct,
  printTable,
  reachedOperator,
  reportingSeeds,
  runFullScenario,
  writeCsv,
  type ScenarioId,
} from "./harness";

/**
 * E2 — per-class detection rate.
 *
 * For each attack class: how often it is caught, WHICH rule caught it, and at
 * WHICH LEG. "Detected" alone hides the difference between catching a spoof on
 * the delivery scan and catching it three legs later, which is the difference
 * between refusing a handoff and investigating one after the fact.
 */

const CLASSES: { id: ScenarioId; label: string; axis: string }[] = [
  { id: "S1", label: "GPS spoofing", axis: "single-event" },
  { id: "S2", label: "Batch scanning a condo tower", axis: "pattern" },
  { id: "S3", label: "Event ID reuse", axis: "hard check (H4)" },
  { id: "S4", label: "Out-of-scope scan", axis: "hard check (H2)" },
  { id: "S5", label: "Clock tampering", axis: "single-event" },
];

const SEEDS_PER_CLASS = 12;

async function main() {
  const rows: Record<string, unknown>[] = [];
  const summary: Record<string, unknown>[] = [];

  for (const klass of CLASSES) {
    const seeds = reportingSeeds(`${BASE_SEED}-e2-${klass.id}`, SEEDS_PER_CLASS);
    let detected = 0;
    const legIndexes: number[] = [];
    const flagCounts = new Map<string, number>();

    for (const seed of seeds) {
      const run = await runFullScenario(klass.id, seed);
      try {
        const legs = run.legs;
        const firstIndex = legs.findIndex(reachedOperator);

        // S3's attack is the REPLAY, which is a second submission of an already
        // sealed eventID rather than a leg of the timeline.
        let caught = firstIndex !== -1;
        let flags = caught ? (legs[firstIndex].verdict?.flags ?? []) : [];
        let at = firstIndex;

        if (klass.id === "S3" && run.replay) {
          if (run.replay.halted?.reason === "EVENT_ID_REUSE") {
            caught = true;
            flags = ["H4"];
            at = legs.length;
          }
        }

        if (caught) {
          detected++;
          legIndexes.push(at);
          for (const flag of flags) flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1);
        }

        rows.push({
          experiment: "E2",
          scenario: klass.id,
          label: klass.label,
          seed,
          half: "report",
          seeds_in_cell: seeds.length,
          detected: caught ? 1 : 0,
          detected_at_leg: caught ? at + 1 : "",
          total_legs: legs.length,
          flags: flags.join(" "),
        });
      } finally {
        run.dispose();
      }
    }

    const meanLeg =
      legIndexes.length > 0
        ? (legIndexes.reduce((a, b) => a + b, 0) / legIndexes.length + 1).toFixed(1)
        : "—";

    summary.push({
      scenario: klass.id,
      label: klass.label,
      n: seeds.length,
      detected: `${detected}/${seeds.length}`,
      rate: pct(detected, seeds.length),
      mean_leg: meanLeg,
      caught_by: [...flagCounts.keys()].sort().join(" ") || "—",
      axis: klass.axis,
    });
  }

  const path = writeCsv("e2-detection-rate.csv", rows);
  printTable("E2 — per-class detection (reporting half only)", summary);
  process.stdout.write(`\n  mean_leg = 1-indexed leg at which the class was first caught\n  ${path}\n`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack}\n`);
  process.exit(1);
});

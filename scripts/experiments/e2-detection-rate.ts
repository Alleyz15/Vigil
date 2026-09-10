import {
  BASE_SEED,
  pct,
  printTable,
  reachedOperator,
  seedsForHalf,
  runFullScenario,
  runIdentityCase,
  writeCsv,
  type HoldoutHalf,
  type IdentityCaseId,
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

type DetectionClass = {
  id: ScenarioId | IdentityCaseId;
  label: string;
  axis: string;
  kind: "scenario" | "identity";
};

const CLASSES: DetectionClass[] = [
  { id: "S1", label: "GPS spoofing", axis: "single-event", kind: "scenario" },
  { id: "S2", label: "Batch scanning a condo tower", axis: "pattern", kind: "scenario" },
  { id: "S3", label: "Event ID reuse", axis: "hard check (H4)", kind: "scenario" },
  { id: "S4", label: "Out-of-scope scan", axis: "hard check (H2)", kind: "scenario" },
  { id: "S5", label: "Clock tampering", axis: "single-event", kind: "scenario" },
  {
    id: "recipient_channel_substitution",
    label: "OTP sent to a different recipient channel",
    axis: "single-event identity",
    kind: "identity",
  },
  {
    id: "replacement_weak_handset",
    label: "Unbound weak replacement handset",
    axis: "single-event identity",
    kind: "identity",
  },
];

const SEEDS_PER_CLASS = 12;

async function main() {
  const half: HoldoutHalf = process.argv.includes("--tune") ? "tune" : "report";
  const rows: Record<string, unknown>[] = [];
  const summary: Record<string, unknown>[] = [];

  for (const klass of CLASSES) {
    const seeds = seedsForHalf(`${BASE_SEED}-e2-${klass.id}`, SEEDS_PER_CLASS, half);
    let detected = 0;
    const legIndexes: number[] = [];
    const flagCounts = new Map<string, number>();

    for (const seed of seeds) {
      const run =
        klass.kind === "identity"
          ? await runIdentityCase(klass.id as IdentityCaseId, seed)
          : await runFullScenario(klass.id as ScenarioId, seed);
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
          half,
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

  const path = writeCsv(half === "tune" ? "e2-detection-rate-tune.csv" : "e2-detection-rate.csv", rows);
  printTable(`E2 — per-class detection (${half} half only)`, summary);
  process.stdout.write(`\n  mean_leg = 1-indexed leg at which the class was first caught\n  ${path}\n`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack}\n`);
  process.exit(1);
});

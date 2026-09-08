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
 * E3 — false positive rate.
 *
 * Clean shipments, across many seeds: how often does ordinary work reach an
 * operator? The brief scores "fewer false alerts" explicitly, and a detection
 * rate reported without this number is meaningless — a system that flags
 * everything detects everything.
 *
 * BROKEN DOWN BY ABORT CODE, because CLAUDE.md's Open reservations flags
 * H1 → freeze as a possible over-refusal and this is where that is settled.
 * If H1 dominates, that is REPORTED, not fixed here: changing a threshold in
 * the run that measured it is the circularity the whole discipline exists to
 * prevent.
 */

const CLEAN: { id: ScenarioId; label: string }[] = [
  { id: "S0", label: "Normal delivery" },
  { id: "S6", label: "GPS degradation underground" },
];

const SEEDS_PER_SCENARIO = 20;

async function main() {
  const rows: Record<string, unknown>[] = [];
  const summary: Record<string, unknown>[] = [];
  const abortCodes = new Map<string, number>();
  const flagCounts = new Map<string, number>();

  let allLegs = 0;
  let allAlerts = 0;

  for (const scenario of CLEAN) {
    const seeds = reportingSeeds(`${BASE_SEED}-e3-${scenario.id}`, SEEDS_PER_SCENARIO);
    let legs = 0;
    let alerts = 0;
    let shipmentsWithAnyAlert = 0;

    for (const seed of seeds) {
      const run = await runFullScenario(scenario.id, seed);
      try {
        let shipmentAlerted = false;

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
            scenario: scenario.id,
            seed,
            half: "report",
            seeds_in_cell: seeds.length,
            leg: ctx.event?.bizStep ?? "",
            decision: ctx.decision ?? "",
            abort_code: ctx.verdict?.abortCode ?? "",
            flags: (ctx.verdict?.flags ?? []).join(" "),
          });
        }

        if (shipmentAlerted) shipmentsWithAnyAlert++;
      } finally {
        run.dispose();
      }
    }

    allLegs += legs;
    allAlerts += alerts;

    summary.push({
      scenario: scenario.id,
      label: scenario.label,
      seeds: seeds.length,
      legs,
      alerts,
      per_leg: pct(alerts, legs),
      shipments_affected: `${shipmentsWithAnyAlert}/${seeds.length}`,
    });
  }

  // A clean run still writes a row, so the CSV records the denominator.
  if (rows.length === 0) {
    rows.push({
      experiment: "E3",
      scenario: "(all)",
      seed: "(none alerted)",
      half: "report",
      seeds_in_cell: SEEDS_PER_SCENARIO,
      leg: "",
      decision: "",
      abort_code: "",
      flags: "",
    });
  }

  const path = writeCsv("e3-false-positives.csv", rows);

  printTable("E3 — false positives on clean shipments (reporting half only)", summary);
  process.stdout.write(`\n  overall: ${allAlerts} alerts across ${allLegs} legs — ${pct(allAlerts, allLegs)}\n`);

  const breakdown = [...abortCodes.entries()].sort((a, b) => b[1] - a[1]);
  if (breakdown.length === 0) {
    process.stdout.write(
      "\n  BY ABORT CODE: none. No clean shipment triggered a hard check in any run.\n" +
        "  H1 -> freeze did NOT dominate; on this data it did not fire at all.\n",
    );
  } else {
    printTable(
      "  by abort code",
      breakdown.map(([code, n]) => ({ abort_code: code, count: n, share: pct(n, allAlerts) })),
    );
    const [top] = breakdown;
    if (top[0] === "H1") {
      process.stdout.write(
        "\n  H1 DOMINATES. Reported, not fixed: changing a threshold in the run that\n" +
          "  measured it would be circular. That is a separate session and a rerun.\n",
      );
    }
  }

  process.stdout.write(`  ${path}\n`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack}\n`);
  process.exit(1);
});

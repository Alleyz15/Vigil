import { spawnSync } from "node:child_process";

/**
 * Every experiment, in order.
 *
 * Sequential and slow on purpose: each one stands up its own database, ledger
 * and world per seed, and running them concurrently would let one experiment's
 * disk churn distort another's timings.
 */
const EXPERIMENTS = [
  "e1-attacker-cost.ts",
  "e2-detection-rate.ts",
  "e3-false-positives.ts",
  "e4-llm-instability.ts",
  "e5-citation-hallucination.ts",
  "e6-threshold-sensitivity.ts",
];

let failed = 0;

for (const experiment of EXPERIMENTS) {
  process.stdout.write(`\n${"=".repeat(78)}\n${experiment}\n${"=".repeat(78)}\n`);
  const result = spawnSync("npx", ["tsx", `scripts/experiments/${experiment}`], {
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) failed++;
}

process.stdout.write(
  failed === 0
    ? "\nAll experiments completed. CSVs in results/.\n"
    : `\n${failed} experiment(s) failed.\n`,
);
process.exit(failed === 0 ? 0 : 1);

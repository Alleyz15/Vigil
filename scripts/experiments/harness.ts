import { mkdirSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentContext } from "@/lib/agent/context";
import type { NodeDeps } from "@/lib/agent/nodes";
import { closeDb } from "@/lib/db/client";
import {
  type GeneratedScenario,
  type IdentityCaseId,
  type ScenarioId,
  buildScenario,
  buildIdentityCase,
  buildWorld,
  createHarness,
  type IngestHarness,
  type NoiseLevel,
  ingestScenario,
  ingestWithApproval,
  makeRng,
  seedFleetBackground,
  splitOf,
} from "@/lib/generate";

/**
 * Shared plumbing for the experiments.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: read a detector threshold to decide what
 * anything does. The generator emits behaviour and the detectors compute
 * statistics over it; a script that shaped the data around a rule would be
 * measuring how well it shaped the data. A purity test enforces this, with one
 * named exception for E6. See CLAUDE.md.
 */

export const RESULTS_DIR = join(process.cwd(), "results");
export const BASE_SEED = "vigil-2026";
export const START_MS = Date.parse("2026-09-07T14:30:00+08:00");

/** The holdout seed. Kept apart from the data seed so one cannot leak into the other. */
export const SPLIT_SEED = "vigil-holdout-2026";
export type HoldoutHalf = "tune" | "report";

/**
 * Which half a run belongs to.
 *
 * Nothing is tuned in this session, so the tuning half is declared and left
 * unused. It exists so a future session that DOES tune has somewhere honest to
 * do it, and so the reporting numbers can say which half they came from.
 */
export function halfOf(key: string): HoldoutHalf {
  return splitOf(key, SPLIT_SEED);
}

/** Seeds for one experiment cell, all selected from exactly one declared half. */
export function seedsForHalf(prefix: string, count: number, half: HoldoutHalf): string[] {
  const seeds: string[] = [];
  for (let i = 0; seeds.length < count && i < count * 8; i++) {
    const seed = `${prefix}-${i}`;
    if (halfOf(seed) === half) seeds.push(seed);
  }
  return seeds;
}

/** Seeds for final reported numbers. */
export function reportingSeeds(prefix: string, count: number): string[] {
  return seedsForHalf(prefix, count, "report");
}

/** Seeds for checking a candidate before the reporting half is opened. */
export function tuningSeeds(prefix: string, count: number): string[] {
  return seedsForHalf(prefix, count, "tune");
}

export type PreparedRun = {
  harness: IngestHarness;
  scenario: GeneratedScenario;
  args: { courierPrivateKey: string; mandateId: string };
  dispose: () => void;
};

/** Release every resource owned by a generated harness, in dependency order. */
export function disposeHarness(harness: IngestHarness): void {
  closeDb(harness.deps.db);
  rmSync(harness.dir, { recursive: true, force: true });
}

/**
 * Stand up a world and seal the courier's warm-up history.
 *
 * The warm-up is not optional: without it every courier is cold-start, every
 * handoff demands a co-signature, and a false-positive rate measured on that
 * would be measuring the absence of history rather than the rules.
 */
export async function prepare(
  id: ScenarioId,
  seed: string,
  options: { deps?: Partial<NodeDeps>; noiseLevel?: NoiseLevel } = {},
): Promise<PreparedRun> {
  const world = buildWorld(seed);
  const scenario = buildScenario(id, {
    world,
    rng: makeRng(seed),
    startMs: START_MS,
    noiseLevel: options.noiseLevel,
  });
  const harness = createHarness(world);

  if (options.deps) Object.assign(harness.deps, options.deps);

  seedFleetBackground(harness, world, {
    excludeCourierId: scenario.courier.courierId,
    startMs: START_MS - 8 * 3_600_000,
  });

  const args = {
    courierPrivateKey: scenario.courier.keys.privateKey,
    mandateId: scenario.courier.mandate.mandateId,
  };

  for (const built of scenario.warmup) {
    await ingestWithApproval(harness, built, args);
  }

  return {
    harness,
    scenario,
    args,
    dispose: () => disposeHarness(harness),
  };
}

/**
 * Run a whole scenario the way the product does.
 *
 * Uses the tested `ingestScenario`, which upserts the scenario's own parcels
 * and records disputes as the round proceeds. Composing those steps by hand
 * here reproduced a bug session 6 already fixed: S2 re-addresses its batch to
 * one tower, and without the upsert the engine measures tower scans against
 * the world's original scattered addresses and fires I10 on all forty.
 */
export async function runFullScenario(id: ScenarioId, seed: string, noiseLevel?: NoiseLevel) {
  const world = buildWorld(seed);
  const scenario = buildScenario(id, {
    world,
    rng: makeRng(seed),
    startMs: START_MS,
    noiseLevel,
  });
  const harness = createHarness(world);

  seedFleetBackground(harness, world, {
    excludeCourierId: scenario.courier.courierId,
    startMs: START_MS - 8 * 3_600_000,
  });

  const run = await ingestScenario(scenario, harness);
  return { ...run, dispose: () => disposeHarness(harness) };
}

/** Run an experiment-only identity case without adding it to the public S0-S6 picker. */
export async function runIdentityCase(id: IdentityCaseId, seed: string) {
  const world = buildWorld(seed);
  const generated = buildIdentityCase(id, {
    world,
    rng: makeRng(seed),
    startMs: START_MS,
  });
  const harness = createHarness(world);

  seedFleetBackground(harness, world, {
    excludeCourierId: generated.scenario.courier.courierId,
    startMs: START_MS - 8 * 3_600_000,
  });

  const run = await ingestScenario(generated.scenario, harness);
  return { ...run, identityCase: generated, dispose: () => disposeHarness(harness) };
}

/** Run a scenario's own legs, after preparation. */
export async function runLegs(run: PreparedRun): Promise<AgentContext[]> {
  const out: AgentContext[] = [];
  for (const built of run.scenario.timeline) {
    const { ctx } = await ingestWithApproval(run.harness, built, run.args);
    out.push(ctx);
  }
  return out;
}

/** Whether a leg reached an operator: anything other than a clean accept. */
export function reachedOperator(ctx: AgentContext): boolean {
  if (ctx.halted?.reason === "PENDING_COSIGNATURE") return false; // awaiting, not alarming
  return ctx.decision !== undefined && ctx.decision !== "accept";
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Write a CSV.
 *
 * EVERY ROW CARRIES ITS SAMPLE SIZE AND ITS SEED. A table lifted out of here
 * into a deck has to carry its own provenance — a number whose n is only
 * mentioned in the surrounding prose becomes a number with no n at all the
 * moment someone copies the table.
 */
export function writeCsv(name: string, rows: Record<string, unknown>[]): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, name);

  if (rows.length === 0) {
    writeFileSync(path, "", "utf8");
    return path;
  }

  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const body = rows.map((row) => headers.map((h) => escape(row[h])).join(",")).join("\n");
  writeFileSync(path, `${headers.join(",")}\n${body}\n`, "utf8");
  return path;
}

/** A small aligned table for the console summary. */
export function printTable(title: string, rows: Record<string, unknown>[]): void {
  process.stdout.write(`\n${title}\n`);
  if (rows.length === 0) {
    process.stdout.write("  (no rows)\n");
    return;
  }

  const headers = Object.keys(rows[0]);
  const widths = headers.map((h) =>
    Math.max(h.length, ...rows.map((r) => String(r[h] ?? "").length)),
  );

  const line = (cells: string[]) =>
    `  ${cells.map((c, i) => c.padEnd(widths[i])).join("  ")}\n`;

  process.stdout.write(line(headers));
  process.stdout.write(`  ${widths.map((w) => "-".repeat(w)).join("  ")}\n`);
  for (const row of rows) {
    process.stdout.write(line(headers.map((h) => String(row[h] ?? ""))));
  }
}

export function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? "n/a" : `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export { type ScenarioId, type NoiseLevel, type IdentityCaseId };

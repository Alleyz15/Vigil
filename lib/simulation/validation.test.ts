import { expect, it } from "vitest";
import { RANDOMIZED_SEED_MANIFEST, runSeedManifest } from "./validation";

it("uses fixed disjoint development and validation manifests", () => {
  const { development, validation } = RANDOMIZED_SEED_MANIFEST;
  expect(development).toHaveLength(20);
  expect(validation).toHaveLength(10);
  expect(new Set([...development, ...validation]).size).toBe(30);
});

it("retains errors and every seed instead of stopping or selecting successful results", async () => {
  const visited: string[] = [];
  const report = await runSeedManifest(async (seed, partition) => {
    visited.push(seed);
    if (visited.length === 2) throw new Error("injected validation failure");
    return { partition, coverage: { evaluated: 13, total: 16 }, source: "synthetic", sampledConditions: [] };
  });
  expect(visited).toEqual([...RANDOMIZED_SEED_MANIFEST.development, ...RANDOMIZED_SEED_MANIFEST.validation]);
  expect(report.results).toHaveLength(30);
  expect(report.results[1]).toMatchObject({ status: "error", error: "injected validation failure" });
  expect(report.summary).toEqual({ total: 30, completed: 29, errors: 1 });
  expect(report.claim).toMatch(/not.*field accuracy/i);
});

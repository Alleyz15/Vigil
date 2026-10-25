import { describe, expect, it } from "vitest";
import { RandomSimulationConfig, simulationOf } from "./config";

const CONFIG = { mode: "randomized", seed: "Demo_2026-10-25", version: "signals-v1" } as const;

describe("versioned simulation input", () => {
  it("accepts only the modeled inputs and preserves the exact seed", () => {
    expect(RandomSimulationConfig.parse(CONFIG)).toEqual(CONFIG);
    for (const seed of ["x", "a".repeat(80), "_-09AZaz"]) {
      expect(RandomSimulationConfig.parse({ ...CONFIG, seed }).seed).toBe(seed);
    }
  });

  it.each(["", "a".repeat(81), "two words", " padded", "line\n", "a.b", "é"])("rejects invalid seed %j", (seed) => {
    expect(() => RandomSimulationConfig.parse({ ...CONFIG, seed })).toThrow();
  });

  it.each([
    { mode: "normal" }, { version: "signals-v2" },
    { thresholds: {} }, { scores: [80] }, { decision: "accept" },
  ])("rejects unsupported versions, modes and outcome controls: %j", (extra) => {
    expect(() => RandomSimulationConfig.parse({ ...CONFIG, ...extra })).toThrow();
  });
});

describe("persisted simulation configuration", () => {
  it("reads a typed config and treats only absent/null storage as legacy", () => {
    const config: RandomSimulationConfig | undefined = simulationOf({ simulationJson: JSON.stringify(CONFIG) });
    expect(config).toEqual(CONFIG);
    expect(simulationOf({})).toBeUndefined();
    expect(simulationOf({ simulationJson: null })).toBeUndefined();
  });

  it.each([
    "", "{", "null", "[]", "{}",
    JSON.stringify({ mode: "randomized", seed: "valid" }),
    JSON.stringify({ ...CONFIG, seed: "" }),
    JSON.stringify({ ...CONFIG, version: "signals-v2" }),
    JSON.stringify({ ...CONFIG, decision: "accept" }),
  ])("fails closed on invalid persisted JSON/shape/version: %j", (simulationJson) => {
    expect(() => simulationOf({ simulationJson })).toThrow();
  });
});

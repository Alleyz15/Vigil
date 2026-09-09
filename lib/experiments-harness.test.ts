import { describe, expect, it } from "vitest";
import { halfOf, seedsForHalf, tuningSeeds } from "@/scripts/experiments/harness";

describe("experiment holdout seed selection", () => {
  it("selects only the requested half and keeps tune/report seeds disjoint", () => {
    const tune = seedsForHalf("session-11", 20, "tune");
    const report = seedsForHalf("session-11", 20, "report");

    expect(tune).toHaveLength(20);
    expect(report).toHaveLength(20);
    expect(tune.every((seed) => halfOf(seed) === "tune")).toBe(true);
    expect(report.every((seed) => halfOf(seed) === "report")).toBe(true);
    expect(tune.filter((seed) => report.includes(seed))).toEqual([]);
  });

  it("provides an explicit tuning-half helper for pre-report checks", () => {
    const seeds = tuningSeeds("session-11-helper", 12);

    expect(seeds).toHaveLength(12);
    expect(seeds.every((seed) => halfOf(seed) === "tune")).toBe(true);
  });
});

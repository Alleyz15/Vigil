import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("simulated-clock provenance", () => {
  it("travels with every surface that prominently renders demo-world dates", () => {
    for (const path of [
      "components/operator/handoffs-workspace.tsx",
      "components/operator/handoff-detail.tsx",
      "components/sender/sender-shipments.tsx",
    ]) {
      expect(source(path), `${path} renders demo dates without provenance`).toContain("SimulatedClockLabel");
    }
  });

  it("takes its anchor from the workbench instead of the browser clock", () => {
    const service = source("lib/workbench/service.ts");
    expect(service).toContain("clockProvenance()");
    expect(service).toContain("anchorIso: this.nowIso");
  });
});

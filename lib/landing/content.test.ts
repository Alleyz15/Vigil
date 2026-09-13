import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NODES } from "@/lib/agent/nodes-list";
import { PIPELINE, PIPELINE_REVEAL } from "./content";

/**
 * The landing page narrates the pipeline. It must narrate THIS pipeline.
 */
describe("the scroll-step section describes the pipeline that runs", () => {
  it("names the eight nodes verbatim and in execution order", () => {
    expect(PIPELINE.map((step) => step.node)).toEqual([...NODES]);
  });

  it("marks exactly plan and explain as model nodes, and gate alone as deciding", () => {
    expect(PIPELINE.filter((s) => s.role === "model").map((s) => s.node)).toEqual(["plan", "explain"]);
    expect(PIPELINE.filter((s) => s.role === "decides").map((s) => s.node)).toEqual(["gate"]);
  });

  /**
   * The reveal cites a file. A citation is only worth printing if the file
   * exists and holds the test the sentence describes — otherwise the page is
   * pointing a judge at nothing, which is worse than not citing.
   */
  it("cites a test file that exists and runs the no-model parity check", () => {
    const path = join(process.cwd(), PIPELINE_REVEAL.source);
    expect(existsSync(path), `${PIPELINE_REVEAL.source} does not exist`).toBe(true);

    const source = readFileSync(path, "utf8");
    expect(source).toContain("seals the same verdict with no LLM");
    expect(source).toContain("runWith(undefined)");
  });

  // Length, not sentence count: "The deterministic engine. The pattern axis."
  // is two fragments and one glance. What a scrolling viewer cannot take in is
  // a long line, so that is what is asserted.
  it("keeps each step short enough to read while scrolling", () => {
    for (const step of PIPELINE) {
      expect(step.line.length, `${step.node} is too long to read while scrolling`).toBeLessThanOrEqual(80);
    }
  });
});

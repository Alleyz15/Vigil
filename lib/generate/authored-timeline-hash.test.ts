import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeRng } from "./rng";
import { AUTHORED_SCENARIO_IDS } from "./scenarios/types";
import { buildScenario } from "./scenarios";
import { buildWorld } from "./world";

const SEED = "vigil-2026";
const START_MS = Date.parse("2026-09-07T14:30:00+08:00");

function authoredTimelineHash(): string {
  const scenarios = AUTHORED_SCENARIO_IDS.map((id) => {
    const scenario = buildScenario(id, {
      world: buildWorld(SEED),
      rng: makeRng(SEED),
      startMs: START_MS,
    });

    return {
      id,
      warmup: scenario.warmup.map((built) => built.event),
      timeline: scenario.timeline.map((built) => built.event),
    };
  });

  return createHash("sha256").update(JSON.stringify(scenarios)).digest("hex");
}

describe("the authored scenario timeline fixture", () => {
  it("keeps all seven seeded timelines and warm-ups byte-identical", () => {
    expect(authoredTimelineHash()).toBe(
      "09a9f7eb71bde4cd3d2b17039c7050fe82aa42315fedc6d38f15c61fceedb2a3",
    );
  });
});

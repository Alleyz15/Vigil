import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { closeDb } from "@/lib/db/client";
import type { EngineResult } from "@/lib/engine/types";
import { buildScenario, buildWorld, createHarness, ingestScenario, makeRng, seedFleetBackground } from "@/lib/generate";
import { createWorkbench, type OperatorWorkbench } from "./service";

let workbench: OperatorWorkbench;

beforeAll(async () => {
  workbench = await createWorkbench({ scenarioIds: ["S0", "S1", "S2", "S3", "S4", "S5", "S6"] });
}, 120_000);

afterAll(() => workbench.close());

function states(result: EngineResult | undefined) {
  if (!result) return {};
  if (result.aborted) return { hard: result.abortCode ?? "aborted" };
  const notEvaluated = new Set(result.coverage.notEvaluated.map((item) => item.id));
  const triggered = new Set(result.flags.map((flag) => flag.id));
  return Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => `I${index + 1}`).map((id) => [
      id,
      notEvaluated.has(id) ? "not_evaluated" : triggered.has(id) ? "triggered" : "clear",
    ]),
  );
}

describe("replaying a sealed handoff", () => {
  it.each(["S0", "S1", "S2", "S3", "S4", "S5", "S6"] as const)(
    "%s reproduces every rule state, both axes, and the decision",
    async (scenarioId) => {
      const world = buildWorld("vigil-2026");
      const scenario = buildScenario(scenarioId, {
        world,
        rng: makeRng("vigil-2026"),
        startMs: Date.parse("2026-09-07T14:30:00+08:00"),
      });
      const originalHarness = createHarness(world);
      seedFleetBackground(originalHarness, world, {
        excludeCourierId: scenario.courier.courierId,
        startMs: Date.parse("2026-09-07T14:30:00+08:00") - 8 * 3_600_000,
      });
      const original = await ingestScenario(scenario, originalHarness);
      const legIndex = scenario.timeline.length - 1;
      const replay = await workbench.replayHandoff(scenarioId, legIndex);
      const sealed = original.legs[legIndex];

      expect(states(replay.engineResult)).toEqual(states(sealed.engineResult));
      expect(replay.verdict?.inconsistencyScore ?? null).toBe(sealed.verdict?.inconsistencyScore ?? null);
      expect(replay.verdict?.patternScore ?? null).toBe(sealed.verdict?.patternScore ?? null);
      expect(replay.decision ?? null).toBe(sealed.decision ?? null);
      closeDb(originalHarness.deps.db);
      rmSync(originalHarness.dir, { recursive: true, force: true });
    },
    60_000,
  );
});

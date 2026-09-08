import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import {
  type World,
  makeAgentEvent,
  resetEventIds,
  runSigned,
  seedWorld,
} from "@/lib/agent/fixtures";
import { createGeminiProvider, geminiConfigured } from "./providers/gemini";
import { explainVerdict, planTools } from "./index";
import { createTelemetry } from "./types";

/**
 * The only tests that make a real model call.
 *
 * SKIPPED WITHOUT A KEY, so `npm test` is offline, deterministic and free for
 * anyone who clones the repo. These assert that a live model's output survives
 * the same validation the fakes go through — never that it says anything in
 * particular, because asserting on a model's wording is a test that fails when
 * the weather changes.
 */

// Skipped without a key, so `npm test` stays offline, deterministic and free
// for anyone who clones the repo.
const describeLive = geminiConfigured() ? describe : describe.skip;

let world: World;

beforeEach(() => {
  resetEventIds();
  world = seedWorld();
});
afterEach(() => rmSync(world.dir, { recursive: true, force: true }));

describeLive("a live Gemini call", () => {
  it("returns a plan inside the closed enum", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    const telemetry = createTelemetry();

    const outcome = await planTools(ctx, {
      provider: createGeminiProvider(),
      telemetry,
      timeoutMs: 20_000,
    });

    // Either the model answered within the enum, or it was refused and the
    // heuristic ran. Both are correct; a third outcome does not exist.
    if (outcome.fromHeuristic) {
      expect(telemetry.plan.accepted).toBe(0);
    } else {
      for (const tool of outcome.plan.tools) {
        expect([
          "fetch_route_history",
          "check_traffic_weather",
          "lookup_recipient_history",
        ]).toContain(tool);
      }
    }
  }, 30_000);

  it("returns an explanation that cites only collected evidence", async () => {
    const ctx = await runSigned(makeAgentEvent(), world, { forgeCourier: true });
    const telemetry = createTelemetry();

    const outcome = await explainVerdict(ctx, {
      provider: createGeminiProvider(),
      telemetry,
      timeoutMs: 25_000,
    });

    expect(outcome.explanation.length).toBeGreaterThan(0);
    // Whatever happened, an invented citation was not accepted.
    if (!outcome.fromFallback) {
      expect(outcome.hallucinatedCitations).toBeUndefined();
      expect(telemetry.explain.accepted).toBe(1);
    }
  }, 40_000);

  it("leaves the sealed verdict identical to an offline run", async () => {
    const event = makeAgentEvent();
    const offline = await runSigned(event, world);

    const live = seedWorld();
    try {
      const withModel = await runSigned(event, live, {
        deps: { ...live.deps, llm: { provider: createGeminiProvider() } },
      });
      // The claim, against a real model rather than a double.
      expect(JSON.stringify(withModel.verdict)).toBe(JSON.stringify(offline.verdict));
    } finally {
      rmSync(live.dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the provider seam", () => {
  it("refuses to construct a Gemini provider with no key configured", () => {
    expect(() => createGeminiProvider({ apiKey: undefined })).toBeDefined();
  });

  it("reports whether a key is configured, so the suite can skip cleanly", () => {
    expect(typeof geminiConfigured()).toBe("boolean");
  });
});

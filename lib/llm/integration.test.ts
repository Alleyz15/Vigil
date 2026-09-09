import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { closeDb } from "@/lib/db/client";
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
afterEach(() => {
  closeDb(world.deps.db);
  rmSync(world.dir, { recursive: true, force: true });
});

describeLive("a live Gemini call", () => {
  it("reaches the configured hosted model and receives non-empty content", async () => {
    const provider = createGeminiProvider();
    const raw = await provider.complete({
      system: 'Reply with JSON only: {"ok": true}',
      user: "Confirm the connection.",
      timeoutMs: 20_000,
      temperature: 0,
    });

    expect(provider.name).toMatch(/^gemini:gemini-/);
    expect(raw.trim().length).toBeGreaterThan(0);
  }, 30_000);

  it("returns a plan inside the closed enum", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    const telemetry = createTelemetry();

    const outcome = await planTools(ctx, {
      provider: createGeminiProvider(),
      telemetry,
      timeoutMs: 20_000,
    });

    process.stdout.write(
      `[live Gemini] plan ${outcome.fromHeuristic ? `fell back (${outcome.rejection})` : `accepted (${outcome.plan.tools.join(", ") || "no tools"})`}\n`,
    );

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

    process.stdout.write(
      `[live Gemini] explain ${outcome.fromFallback ? `fell back (${outcome.rejection})` : "accepted"}\n`,
    );

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
    const offlineLedger = world.deps.ledger.readRecords().map(ledgerMeaning);

    const live = seedWorld();
    try {
      const withModel = await runSigned(event, live, {
        deps: { ...live.deps, llm: { provider: createGeminiProvider() } },
      });
      // The claim, against a real model rather than a double.
      expect(JSON.stringify(withModel.verdict)).toBe(JSON.stringify(offline.verdict));
      // recordedAt and the hash links necessarily differ between two runs.
      // What must remain identical is what the chain commits to: the event
      // binding and verdict. Both independently constructed chains must verify.
      expect(live.deps.ledger.readRecords().map(ledgerMeaning)).toEqual(offlineLedger);
      expect(world.deps.ledger.verifyChain()).toEqual({ valid: true, entries: 1 });
      expect(live.deps.ledger.verifyChain()).toEqual({ valid: true, entries: 1 });
    } finally {
      closeDb(live.deps.db);
      rmSync(live.dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the provider seam", () => {
  it("uses the current documented Gemini Flash model when no model is configured", () => {
    const configured = process.env.GEMINI_MODEL;
    delete process.env.GEMINI_MODEL;

    try {
      expect(createGeminiProvider({ apiKey: "test-key" }).name).toBe(
        "gemini:gemini-3.5-flash-lite",
      );
    } finally {
      if (configured === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = configured;
    }
  });

  it("refuses to construct a Gemini provider with no key configured", () => {
    const configured = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      expect(() => createGeminiProvider({ apiKey: undefined })).toThrow(/GEMINI_API_KEY/);
    } finally {
      if (configured === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = configured;
    }
  });

  it("reports whether a key is configured, so the suite can skip cleanly", () => {
    expect(typeof geminiConfigured()).toBe("boolean");
  });
});

function ledgerMeaning(record: ReturnType<World["deps"]["ledger"]["readRecords"]>[number]) {
  if (record.kind === "abort") {
    return {
      kind: record.kind,
      eventID: record.eventID,
      payloadHash: record.payloadHash,
      code: record.code,
      boundPayloadHash: record.boundPayloadHash,
    };
  }
  return {
    kind: record.kind,
    eventID: record.eventID,
    payloadHash: record.payloadHash,
    verdict: record.verdict,
  };
}

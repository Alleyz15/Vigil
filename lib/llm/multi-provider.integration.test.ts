import { describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { closeDb } from "@/lib/db/client";
import {
  makeAgentEvent,
  resetEventIds,
  runSigned,
  seedWorld,
  type World,
} from "@/lib/agent/fixtures";
import {
  anthropicConfigured,
  checkOllamaAvailability,
  createAnthropicProvider,
  createGeminiProvider,
  createOllamaProvider,
  createTelemetry,
  explainVerdict,
  geminiConfigured,
  ollamaConfigured,
  planTools,
  type LlmProvider,
} from "./index";

const allConfigured = anthropicConfigured() && geminiConfigured() && ollamaConfigured();
const describeLive = allConfigured ? describe : describe.skip;

function providers(): LlmProvider[] {
  return [createGeminiProvider(), createAnthropicProvider(), createOllamaProvider()];
}

function dispose(world: World): void {
  closeDb(world.deps.db);
  rmSync(world.dir, { recursive: true, force: true });
}

describeLive("the live three-family provider seam", () => {
  it("finds and warms the configured local model", async () => {
    const availability = await checkOllamaAvailability({ timeoutMs: 5_000 });
    expect(availability.available, `installed: ${availability.installed.join(", ")}`).toBe(true);

    const provider = createOllamaProvider();
    const raw = await provider.complete({
      system: 'Reply with JSON only: {"ok":true}',
      user: "Warm the configured model.",
      timeoutMs: 90_000,
      temperature: 0,
    });
    expect(provider.name).toBe("ollama:qwen2.5:7b");
    expect(raw.trim().length).toBeGreaterThan(0);
  }, 100_000);

  it("keeps every live plan inside the enum and every explanation behind enforcement", async () => {
    for (const provider of providers()) {
      resetEventIds();
      const world = seedWorld();
      try {
        const ctx = await runSigned(makeAgentEvent(), world, { forgeCourier: true });
        const telemetry = createTelemetry();
        const plan = await planTools(ctx, { provider, telemetry, timeoutMs: 60_000 });
        const explanation = await explainVerdict(ctx, { provider, telemetry, timeoutMs: 60_000 });

        expect(plan.plan.tools.every((tool) => [
          "fetch_route_history",
          "check_traffic_weather",
          "lookup_recipient_history",
        ].includes(tool))).toBe(true);
        expect(explanation.explanation.length).toBeGreaterThan(0);
        if (!explanation.fromFallback) {
          expect(explanation.hallucinatedCitations).toBeUndefined();
          expect(telemetry.explain.accepted).toBe(1);
        }
        process.stdout.write(
          `[live ${provider.name}] plan=${plan.fromHeuristic ? plan.rejection : "accepted"} ` +
            `explain=${explanation.fromFallback ? explanation.rejection : "accepted"}\n`,
        );
      } finally {
        dispose(world);
      }
    }
  }, 240_000);

  it("seals the same verdict with no model and with each live family", async () => {
    const event = makeAgentEvent();
    const offlineWorld = seedWorld();
    try {
      const offline = await runSigned(event, offlineWorld);
      const expected = JSON.stringify(offline.verdict);
      const expectedLedger = offlineWorld.deps.ledger.readRecords().map(ledgerMeaning);

      for (const provider of providers()) {
        const liveWorld = seedWorld();
        try {
          const live = await runSigned(event, liveWorld, {
            deps: {
              ...liveWorld.deps,
              llm: { provider, planTimeoutMs: 60_000, explainTimeoutMs: 60_000 },
            },
          });
          expect(JSON.stringify(live.verdict), provider.name).toBe(expected);
          expect(liveWorld.deps.ledger.readRecords().map(ledgerMeaning), provider.name).toEqual(
            expectedLedger,
          );
          expect(liveWorld.deps.ledger.verifyChain()).toEqual({ valid: true, entries: 1 });
        } finally {
          dispose(liveWorld);
        }
      }
    } finally {
      dispose(offlineWorld);
    }
  }, 300_000);
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

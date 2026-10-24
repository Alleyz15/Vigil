import { expect, it } from "vitest";
import { rmSync } from "node:fs";
import { closeDb } from "@/lib/db/client";
import { makeAgentEvent, runSigned, seedWorld } from "@/lib/agent/fixtures";
import { activeAgentLlm, resolveRuntimeLlm } from "./runtime";

it.skipIf(process.env.VIGIL_TEST_FAILOVER !== "1")("survives an injected Gemini outage using live Haiku behind the same validation", async () => {
  const runtime = resolveRuntimeLlm({ ...process.env, VIGIL_LLM_PROVIDER: "gemini" });
  expect(runtime.fallbackProvider, "ANTHROPIC_API_KEY must configure the live fallback").toBeDefined();
  const offlineWorld = seedWorld();
  const liveWorld = seedWorld();
  try {
    const event = makeAgentEvent();
    const offline = await runSigned(event, offlineWorld);
    const llm = activeAgentLlm(runtime);
    llm.provider = { name: runtime.provider!.name, complete: async () => { throw new Error("503 injected Gemini outage"); } };
    llm.planTimeoutMs = 25_000;
    llm.explainTimeoutMs = 25_000;
    const live = await runSigned(event, liveWorld, { deps: { ...liveWorld.deps, llm } });
    expect(live.planFromHeuristic, live.planRejection).toBe(false);
    expect(live.explanationFromFallback, live.explanationRejection).toBe(false);
    expect(live.planModelName).toBe(`anthropic:${runtime.fallbackModelId}`);
    expect(live.explanationModelName).toBe(`anthropic:${runtime.fallbackModelId}`);
    expect(live.explanationFailoverReason).toContain("503 injected Gemini outage");
    expect(JSON.stringify(live.verdict)).toBe(JSON.stringify(offline.verdict));
    const meaning = (world: typeof liveWorld) => world.deps.ledger.readRecords().map((record) => ({ eventID: record.eventID, payloadHash: record.payloadHash, verdict: record.kind === "verdict" ? record.verdict : null }));
    expect(meaning(liveWorld)).toEqual(meaning(offlineWorld));
    expect(liveWorld.deps.ledger.verifyChain()).toEqual({ valid: true, entries: 1 });
    console.info(`Live failover: ${live.planModelName} plan accepted; ${live.explanationModelName} explanation accepted; sealed verdict and ledger payload unchanged.`);
  } finally {
    for (const world of [offlineWorld, liveWorld]) { closeDb(world.deps.db); rmSync(world.dir, { recursive: true, force: true }); }
  }
}, 60_000);

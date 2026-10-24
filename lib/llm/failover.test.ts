import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { makeAgentEvent, resetEventIds, runSigned, seedWorld, type World } from "@/lib/agent/fixtures";
import { planTools } from "./plan";
import { explainVerdict } from "./explain";
import type { LlmProvider } from "./types";
import { scriptedProvider, hangingProvider } from "./providers/fake";

let world: World;
beforeEach(() => { resetEventIds(); world = seedWorld(); });
afterEach(() => { vi.useRealTimers(); rmSync(world.dir, { recursive: true, force: true }); });

const gemini: LlmProvider = { name: "gemini:primary", complete: async () => { throw new Error("429 Too Many Requests"); } };
const haiku: LlmProvider = {
  name: "anthropic:claude-haiku-4-5-20251001",
  complete: async ({ system }) => system.includes("OPTIONAL background checks")
    ? JSON.stringify({ tools: [], rationale: "No optional context needed." })
    : JSON.stringify({ summary: "The handoff was accepted.", citations: ["decision"], nextStep: "" }),
};

describe("validated model failover", () => {
  it("uses Haiku after a Gemini provider failure and records both identities", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    const result = await explainVerdict(ctx, { provider: gemini, fallbackProvider: haiku });
    expect(result.fromFallback).toBe(false);
    expect(result.modelName).toBe("anthropic:claude-haiku-4-5-20251001");
    expect(result.failoverReason).toContain("gemini:primary: provider_error: 429");
  });

  it("retries a rejected whole plan with Haiku rather than keeping valid members", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    const invalid: LlmProvider = { name: "gemini:primary", complete: async () => JSON.stringify({ tools: ["check_traffic_weather", "invented_tool"] }) };
    const planner: LlmProvider = { ...haiku, complete: async () => JSON.stringify({ tools: ["lookup_recipient_history"], rationale: "Recipient context." }) };
    const result = await planTools(ctx, { provider: invalid, fallbackProvider: planner });
    expect(result.fromHeuristic).toBe(false);
    expect(result.plan.tools).toEqual(["lookup_recipient_history"]);
    expect(result.failoverReason).toContain("unknown_tool");
  });

  it("rejects an invented Haiku citation and preserves both failures", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    const invalid: LlmProvider = { ...haiku, complete: async () => JSON.stringify({ summary: "The handoff was accepted.", citations: ["invented_evidence"] }) };
    const result = await explainVerdict(ctx, { provider: gemini, fallbackProvider: invalid });
    expect(result.fromFallback).toBe(true);
    expect(result.rejection).toBe("bad_citation");
    expect(result.failoverReason).toContain("429");
  });

  it("does not call Haiku when Gemini succeeds", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    const primary = { ...haiku, name: "gemini:primary" };
    const result = await explainVerdict(ctx, { provider: primary, fallbackProvider: { ...haiku, complete: async () => { throw new Error("must not be called"); } } });
    expect(result.fromFallback).toBe(false);
    expect(result.modelName).toBe("gemini:primary");
    expect(result.failoverReason).toBeUndefined();
  });

  it("uses Haiku after the primary deadline and falls back visibly if both providers fail", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    const result = await planTools(ctx, { provider: hangingProvider(), fallbackProvider: haiku, timeoutMs: 1 });
    expect(result.fromHeuristic).toBe(false);
    expect(result.failoverReason).toContain("timed out after 1ms");
    const failed = await planTools(ctx, { provider: gemini, fallbackProvider: { ...haiku, complete: async () => { throw new Error("503 Service Unavailable"); } } });
    expect(failed.fromHeuristic).toBe(true);
    expect(failed.failoverReason).toContain("429");
    expect(failed.rejection).toContain("503");
  });

  it("seals identical verdict and ledger bytes after validated model failover", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T02:15:30.000Z"));
    const event = makeAgentEvent();
    const offline = await runSigned(event, world);
    const other = seedWorld();
    try {
      const fallback = scriptedProvider("anthropic:claude-haiku-4-5-20251001", {
        plan: { tools: ["check_traffic_weather"], rationale: "Check context." },
        explain: { summary: "The handoff was accepted.", citations: ["decision"] },
      });
      const live = await runSigned(event, other, { deps: { ...other.deps, llm: { provider: gemini, fallbackProvider: fallback } } });
      expect(live.planFromHeuristic).toBe(false);
      expect(live.explanationFromFallback).toBe(false);
      expect(live.planModelName).toBe("anthropic:claude-haiku-4-5-20251001");
      expect(live.explanationModelName).toBe("anthropic:claude-haiku-4-5-20251001");
      expect(JSON.stringify(live.verdict)).toBe(JSON.stringify(offline.verdict));
      expect(other.deps.ledger.readRecords()).toEqual(world.deps.ledger.readRecords());
    } finally { rmSync(other.dir, { recursive: true, force: true }); }
  });
});

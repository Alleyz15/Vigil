import { describe, expect, it } from "vitest";
import { fixedProvider, unreachableProvider } from "@/lib/llm";
import {
  CELL_ID,
  EPC,
  KL_AMPANG,
  makeAgentEvent,
  resetEventIds,
} from "@/lib/agent/fixtures";
import { createContext } from "@/lib/agent/context";
import { EpcisEvent } from "@/lib/epcis";
import {
  agreementStats,
  captureCompletion,
  classifyRawResponse,
  neutralEventEvidence,
  parseModelDecision,
  replayCaptured,
} from "./llm-live";

describe("live LLM experiment observations", () => {
  it.each([
    ['{"decision":"accept"}', "strict_json"],
    ['```json\n{"decision":"accept"}\n```', "markdown_fenced_json"],
    ['Here is the object: {"decision":"accept"} Done.', "prose_wrapped_json"],
    ['{"decision": accept}', "malformed_json"],
    ["I cannot make that decision.", "refusal_text"],
    ["", "empty"],
  ] as const)("classifies raw response form %s", (raw, expected) => {
    expect(classifyRawResponse(raw)).toBe(expected);
  });

  it("captures one provider response with its model name and latency", async () => {
    const captured = await captureCompletion(
      fixedProvider("gemini:test-model", '{"decision":"accept"}'),
      { system: "system", user: "user", timeoutMs: 100 },
    );

    expect(captured.provider).toBe("gemini:test-model");
    expect(captured.raw).toBe('{"decision":"accept"}');
    expect(captured.shape).toBe("strict_json");
    expect(captured.error).toBeUndefined();
    expect(captured.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("replays the exact captured provider failure", async () => {
    const captured = await captureCompletion(unreachableProvider("429 rate limited"), {
      system: "system",
      user: "user",
      timeoutMs: 100,
    });

    expect(captured.error).toBe("429 rate limited");
    await expect(
      replayCaptured(captured).complete({ system: "x", user: "y", timeoutMs: 100 }),
    ).rejects.toThrow("429 rate limited");
  });

  it("reports top shares and pairwise disagreement without hiding the histogram", () => {
    expect(agreementStats(["accept", "accept", "flag", "freeze", "accept"])).toEqual({
      attempts: 5,
      histogram: { accept: 3, flag: 1, freeze: 1 },
      distinct: 3,
      top1: "accept",
      top1Share: 0.6,
      top2Share: 0.8,
      pairwiseDisagreement: 0.7,
    });
  });

  it("describes raw evidence without leaking the engine's verdict or flags into E4", () => {
    resetEventIds();
    const event = EpcisEvent.parse(makeAgentEvent());
    const ctx = createContext(event);
    ctx.event = event;
    ctx.decision = "freeze";
    ctx.parcel = {
      epc: EPC,
      known: true,
      recipientPoint: KL_AMPANG,
      declaredValueSen: 12_000,
    };

    const evidence = neutralEventEvidence(ctx, [
      {
        siteId: CELL_ID,
        kind: "cell",
        lat: KL_AMPANG.latitude,
        lng: KL_AMPANG.longitude,
        label: "independent cell registry entry",
      },
    ]);

    expect(evidence).toContain("mockLocationProvider");
    expect(evidence).toContain("independent cell registry entry");
    expect(evidence).not.toContain("freeze");
    expect(evidence).not.toContain("inconsistencyScore");
    expect(evidence).not.toContain("flags");
  });

  it("parses only a closed decision object for E4", () => {
    expect(parseModelDecision('{"decision":"flag"}')).toEqual({ decision: "flag" });
    expect(parseModelDecision('{"decision":"flag","confidence":0.9}')).toEqual({
      rejection: "schema_invalid",
    });
    expect(parseModelDecision("not json")).toEqual({ rejection: "schema_invalid" });
  });
});

import { describe, expect, it } from "vitest";
import { createContext } from "@/lib/agent/context";
import type { Decision } from "@/lib/ledger/types";
import { explainVerdict, structuredExplanation } from "./explain";
import { heuristicPlan, planTools } from "./plan";
import { fixedProvider } from "./providers/fake";
import { createTelemetry, type LlmProvider } from "./types";

function context(decision: Decision = "freeze") {
  const ctx = createContext({});
  ctx.verdict = {
    decision, inconsistencyScore: 80, patternScore: 80,
    basis: "both_axes", requiresCosign: false, flags: [],
  };
  return ctx;
}

const actions = [
  { decision: "accept", past: "accepted", base: "accept" },
  { decision: "flag", past: "flagged", base: "flag" },
  { decision: "escalate", past: "escalated", base: "escalate" },
  { decision: "freeze", past: "frozen", base: "freeze" },
] as const;

describe("the explanation must preserve the exact sealed action", () => {
  for (const actual of actions) {
    for (const claimed of actions) {
      it(`${actual.decision}: ${claimed.past} is ${actual === claimed ? "consistent" : "contradictory"}`, async () => {
        const ctx = context(actual.decision);
        const before = JSON.stringify(ctx.verdict);
        const telemetry = createTelemetry();
        const summary = `The handoff was ${claimed.past}.`;
        const result = await explainVerdict(ctx, {
          provider: fixedProvider("gemini:test", JSON.stringify({ summary, citations: ["decision"] })),
          telemetry,
        });
        expect(result.fromFallback).toBe(actual !== claimed);
        if (actual === claimed) {
          expect(result.explanation).toBe(summary);
          expect(telemetry.explain.accepted).toBe(1);
        } else {
          expect(result.rejection).toContain("decision_contradiction");
          expect(result.explanation).toBe(structuredExplanation(ctx));
          expect(result.citations).toBeUndefined();
          expect(telemetry.explain.accepted).toBe(0);
          expect(telemetry.explain.rejected.decision_contradiction).toBe(1);
        }
        expect(JSON.stringify(ctx.verdict)).toBe(before);
      });
    }
  }

  it.each(actions)("rejects an incompatible $base next step as part of the whole response", async ({ decision, base }) => {
    const ctx = context(decision === "accept" ? "freeze" : "accept");
    const result = await explainVerdict(ctx, {
      provider: fixedProvider("gemini:test", JSON.stringify({
        summary: "The deterministic checks are complete.", nextStep: `Next action: ${base}.`, citations: ["decision"],
      })),
    });
    expect(result.fromFallback).toBe(true);
    expect(result.rejection).toContain("decision_contradiction");
  });

  it.each([
    { decision: "freeze", summary: "The handoff was frozen because the mock-location flag was enabled." },
    { decision: "escalate", summary: "The handoff was escalated because the pattern flag fired." },
    { decision: "accept", summary: "The mock-location flag was off. The handoff was accepted." },
  ] as const)("$decision preserves descriptive flag nouns", async ({ decision, summary }) => {
    const ctx = context(decision);
    const before = JSON.stringify(ctx.verdict);
    const telemetry = createTelemetry();
    const result = await explainVerdict(ctx, {
      provider: fixedProvider("gemini:test", JSON.stringify({ summary, citations: ["decision"] })),
      telemetry,
    });
    expect(result.fromFallback).toBe(false);
    expect(result.explanation).toBe(summary);
    expect(result.citations).toEqual(["decision"]);
    expect(result.rejection).toBeUndefined();
    expect(telemetry.explain.accepted).toBe(1);
    expect(JSON.stringify(ctx.verdict)).toBe(before);
  });

  it.each([
    "Flag.",
    "Decision: flag.",
    "The mock-location flag was enabled. Decision: flag.",
    "The pattern flag fired. Flag the handoff.",
  ])("still rejects the asserted action in %s", async (summary) => {
    const ctx = context("freeze");
    const result = await explainVerdict(ctx, {
      provider: fixedProvider("gemini:test", JSON.stringify({ summary, citations: ["decision"] })),
    });
    expect(result.fromFallback).toBe(true);
    expect(result.rejection).toBe('decision_contradiction: "flag"');
    expect(result.explanation).toBe(structuredExplanation(ctx));
    expect(result.citations).toBeUndefined();
  });

  it("tries Haiku after an exact-action contradiction", async () => {
    const result = await explainVerdict(context("flag"), {
      provider: fixedProvider("gemini:test", '{"summary":"The handoff was frozen.","citations":["decision"]}'),
      fallbackProvider: fixedProvider("anthropic:haiku-test", '{"summary":"The handoff was flagged.","citations":["decision"]}'),
    });
    expect(result.fromFallback).toBe(false);
    expect(result.explanation).toBe("The handoff was flagged.");
    expect(result.modelName).toBe("anthropic:haiku-test");
    expect(result.failoverReason).toContain("decision_contradiction");
  });

  it("keeps negated incompatible actions and words containing action substrings", async () => {
    const summary = "The handoff was flagged, not frozen and not escalated. The flagger reviewed the unaccepted draft.";
    const result = await explainVerdict(context("flag"), {
      provider: fixedProvider("gemini:test", JSON.stringify({ summary, citations: ["decision"] })),
    });
    expect(result.fromFallback).toBe(false);
    expect(result.explanation).toBe(summary);
  });
});

describe("structured roots are accepted or rejected whole", () => {
  for (const node of ["plan", "explain"] as const) {
    const valid = node === "plan"
      ? '{"tools":["check_traffic_weather"]}'
      : '{"summary":"The handoff was frozen.","citations":["decision"]}';
    const invalidRoots = [
      `[${valid},"invented_member"]`,
      `[${valid}]`,
      JSON.stringify(valid),
      `{"nested":${valid}}`,
      `[${valid},]`,
      `${valid},"invented_member"`,
      `Here is the response: [\`\`\`json\n${valid}\n\`\`\`,"invented_member"]`,
    ];
    for (const [index, raw] of invalidRoots.entries()) {
      it(`${node} rejects root ${index} instead of retaining its object`, async () => {
        const ctx = context();
        const telemetry = createTelemetry();
        const args = { provider: fixedProvider("gemini:test", raw), telemetry };
        if (node === "plan") {
          const result = await planTools(ctx, args);
          expect(result.fromHeuristic).toBe(true);
          expect(result.plan).toEqual(heuristicPlan(ctx));
        } else {
          const result = await explainVerdict(ctx, args);
          expect(result.fromFallback).toBe(true);
          expect(result.explanation).toBe(structuredExplanation(ctx));
        }
        expect(telemetry[node].accepted).toBe(0);
        expect(telemetry[node].attempts).toBe(1);
      });
    }

    for (const wrapper of ["plain", "json-fence", "bare-fence", "prose"] as const) {
      it(`${node} preserves a valid ${wrapper} response`, async () => {
        const raw = wrapper === "plain" ? `  ${valid}\n`
          : wrapper === "json-fence" ? `Here is the result:\n\`\`\`json\n${valid}\n\`\`\`\nExplanation follows.`
          : wrapper === "bare-fence" ? `\`\`\`\n${valid}\n\`\`\``
          : `Sure! ${valid} Hope that helps.`;
        const args = { provider: fixedProvider("gemini:test", raw) };
        if (node === "plan") expect((await planTools(context(), args)).fromHeuristic).toBe(false);
        else expect((await explainVerdict(context(), args)).fromFallback).toBe(false);
      });
    }

    it(`${node} sends a fenced invalid root to Haiku without retaining members`, async () => {
      const ctx = context();
      const telemetry = createTelemetry();
      const fallback = node === "plan" ? '{"tools":["lookup_recipient_history"]}'
        : '{"summary":"The scope was frozen.","citations":["decision"]}';
      const args = {
        provider: fixedProvider("gemini:test", `\`\`\`json\n[${valid},"invented_member"]\n\`\`\``),
        fallbackProvider: fixedProvider("anthropic:haiku-test", fallback), telemetry,
      };
      const result = node === "plan" ? await planTools(ctx, args) : await explainVerdict(ctx, args);
      expect(result.modelName).toBe("anthropic:haiku-test");
      expect(result.failoverReason).toContain("schema_invalid");
      if ("plan" in result) expect(result.plan.tools).toEqual(["lookup_recipient_history"]);
      else expect(result.explanation).toBe("The scope was frozen.");
      expect(telemetry[node].attempts).toBe(2);
      expect(telemetry[node].accepted).toBe(1);
      expect(telemetry[node].rejected.schema_invalid).toBe(1);
    });
  }
});

describe("any provider rejection follows normal failover", () => {
  for (const node of ["plan", "explain"] as const) {
    for (const thrown of [null, undefined, "service unavailable"]) {
      for (const recover of [true, false]) {
        it(`${node}: ${String(thrown)} ${recover ? "recovers with Haiku" : "uses deterministic fallback if both fail"}`, async () => {
          const ctx = context();
          const before = JSON.stringify(ctx.verdict);
          const telemetry = createTelemetry();
          const provider: LlmProvider = { name: "gemini:test", complete: async () => { throw thrown; } };
          const fallbackProvider: LlmProvider = {
            name: "anthropic:haiku-test",
            complete: async () => {
              if (!recover) throw thrown;
              return node === "plan" ? '{"tools":["lookup_recipient_history"]}'
                : '{"summary":"The handoff was frozen.","citations":["decision"]}';
            },
          };
          const args = { provider, fallbackProvider, telemetry };
          const result = node === "plan" ? await planTools(ctx, args) : await explainVerdict(ctx, args);
          expect(result.modelName).toBe("anthropic:haiku-test");
          expect(result.failoverReason).toContain(`provider_error: ${String(thrown)}`);
          if ("plan" in result) {
            expect(result.fromHeuristic).toBe(!recover);
            expect(result.plan).toEqual(recover ? { tools: ["lookup_recipient_history"] } : heuristicPlan(ctx));
          } else {
            expect(result.fromFallback).toBe(!recover);
            expect(result.explanation).toBe(recover ? "The handoff was frozen." : structuredExplanation(ctx));
          }
          if (!recover) expect(result.rejection).toBe(`provider_error: ${String(thrown)}`);
          expect(telemetry[node].attempts).toBe(2);
          expect(telemetry[node].accepted).toBe(recover ? 1 : 0);
          expect(telemetry[node].rejected.provider_error).toBe(recover ? 1 : 2);
          expect(JSON.stringify(ctx.verdict)).toBe(before);
        });
      }
    }
  }
});

describe("unprintable provider rejections cannot interrupt failover", () => {
  const unprintable = [
    { label: "null-prototype object", make: () => Object.create(null) },
    { label: "throwing primitive conversion", make: () => ({ [Symbol.toPrimitive]() { throw new Error("conversion failed"); } }) },
    { label: "throwing Error.message getter", make: () => Object.defineProperty(new Error(), "message", { get() { throw new Error("message failed"); } }) },
    { label: "revoked proxy", make: () => { const proxy = Proxy.revocable({}, {}); proxy.revoke(); return proxy.proxy; } },
  ];
  for (const node of ["plan", "explain"] as const) {
    for (const { label, make } of unprintable) {
      for (const recover of [true, false]) {
        it(`${node}: ${label} ${recover ? "recovers with Haiku" : "uses deterministic fallback if both fail"}`, async () => {
          const ctx = context();
          const before = JSON.stringify(ctx.verdict);
          const telemetry = createTelemetry();
          const provider: LlmProvider = { name: "gemini:test", complete: async () => { throw make(); } };
          const fallbackProvider: LlmProvider = {
            name: "anthropic:haiku-test",
            complete: async () => {
              if (!recover) throw make();
              return node === "plan" ? '{"tools":["lookup_recipient_history"]}'
                : '{"summary":"The handoff was frozen.","citations":["decision"]}';
            },
          };
          const args = { provider, fallbackProvider, telemetry };
          const result = node === "plan" ? await planTools(ctx, args) : await explainVerdict(ctx, args);
          expect(result.modelName).toBe("anthropic:haiku-test");
          expect(result.failoverReason).toContain("provider_error:");
          if ("plan" in result) {
            expect(result.fromHeuristic).toBe(!recover);
            expect(result.plan).toEqual(recover ? { tools: ["lookup_recipient_history"] } : heuristicPlan(ctx));
          } else {
            expect(result.fromFallback).toBe(!recover);
            expect(result.explanation).toBe(recover ? "The handoff was frozen." : structuredExplanation(ctx));
          }
          if (!recover) expect(result.rejection).toMatch(/^provider_error: .+/);
          expect(telemetry[node].attempts).toBe(2);
          expect(telemetry[node].accepted).toBe(recover ? 1 : 0);
          expect(telemetry[node].rejected.provider_error).toBe(recover ? 1 : 2);
          expect(JSON.stringify(ctx.verdict)).toBe(before);
        });
      }
    }
  }
});

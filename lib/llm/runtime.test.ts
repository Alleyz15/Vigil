import { describe, expect, it } from "vitest";
import { bootstrapAgentLlm, resolveRuntimeLlm } from "./runtime";

describe("the app runtime model choice", () => {
  it("offers Haiku as Gemini failover when its key is configured", () => {
    const runtime = resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "test-gemini", ANTHROPIC_API_KEY: "test-haiku" });
    expect(runtime.fallbackProvider?.name).toBe("anthropic:claude-haiku-4-5-20251001");
    expect(JSON.stringify(runtime)).not.toContain("test-haiku");
  });
  it("keeps all model providers disabled for deterministic QA", () => {
    const runtime = resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "none", GEMINI_API_KEY: "test-gemini", ANTHROPIC_API_KEY: "test-haiku" });
    expect(runtime.provider).toBeNull();
    expect(runtime.fallbackProvider).toBeUndefined();
  });
  it("allows Gemini failover to be explicitly disabled", () => {
    const runtime = resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "test-gemini", ANTHROPIC_API_KEY: "test-haiku", VIGIL_LLM_FALLBACK_PROVIDER: "none" });
    expect(runtime.fallbackProvider).toBeUndefined();
    expect(runtime.provider?.name).toBe("gemini:gemini-3.5-flash-lite");
  });
  it("disables an invalid fallback selection with a visible reason", () => {
    const runtime = resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "test-gemini", ANTHROPIC_API_KEY: "test-haiku", VIGIL_LLM_FALLBACK_PROVIDER: "typo" });
    expect(runtime.fallbackProvider).toBeUndefined();
    expect(runtime.reason).toContain("VIGIL_LLM_FALLBACK_PROVIDER is invalid");
  });
  it("identifies Haiku when the Gemini key is missing", () => {
    const runtime = resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "gemini", ANTHROPIC_API_KEY: "test-haiku" });
    expect(runtime.provider?.name).toBe("anthropic:claude-haiku-4-5-20251001");
    expect(runtime.modelId).toBe("claude-haiku-4-5-20251001");
    expect(runtime.reason).toContain("GEMINI_API_KEY is not configured");
  });
  it("defaults to none instead of making an undeclared network call", () => {
    const runtime = resolveRuntimeLlm({});
    expect(runtime).toMatchObject({ selection: "none", provider: null, modelId: null, keyPresent: false });
  });

  it("selects Gemini explicitly and reports only key presence", () => {
    const runtime = resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "secret-not-for-output" });
    expect(runtime.selection).toBe("gemini");
    expect(runtime.provider?.name).toBe("gemini:gemini-3.5-flash-lite");
    expect(runtime.modelId).toBe("gemini-3.5-flash-lite");
    expect(runtime.keyPresent).toBe(true);
    expect(JSON.stringify(runtime)).not.toContain("secret-not-for-output");
  });

  it("falls back with a visible reason when the selected provider is unavailable", () => {
    const runtime = resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "anthropic" });
    expect(runtime.provider).toBeNull();
    expect(runtime.reason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("distinguishes an intentional seeded-bootstrap skip from no configuration", () => {
    const configured = resolveRuntimeLlm({
      VIGIL_LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: "secret-not-for-output",
    });
    const seeded = bootstrapAgentLlm(configured).runtime;
    const disabled = bootstrapAgentLlm(resolveRuntimeLlm({})).runtime;

    expect(seeded).toMatchObject({ mode: "skipped_seed_bootstrap", modelId: "gemini-3.5-flash-lite" });
    expect(seeded?.reason).toMatch(/configured.*seeded bootstrap.*skips model calls/i);
    expect(disabled).toMatchObject({ mode: "disabled", modelId: null });
    expect(disabled?.reason).toMatch(/selected explicitly/i);
  });
});

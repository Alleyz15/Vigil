import { describe, expect, it } from "vitest";
import { bootstrapAgentLlm, resolveRuntimeLlm } from "./runtime";

describe("the app runtime model choice", () => {
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

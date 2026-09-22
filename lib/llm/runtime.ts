import type { AgentLlm } from "@/lib/agent/nodes";
import { createTelemetry } from "./types";
import { createGeminiProvider } from "./providers/gemini";
import { createAnthropicProvider } from "./providers/anthropic";
import { createOllamaProvider } from "./providers/ollama";
import type { LlmProvider } from "./types";

export type RuntimeProvider = "none" | "gemini" | "anthropic" | "ollama";
export type RuntimeLlm = {
  selection: RuntimeProvider;
  provider: LlmProvider | null;
  modelId: string | null;
  keyPresent: boolean;
  reason: string;
};

export function resolveRuntimeLlm(env: Record<string, string | undefined> = process.env): RuntimeLlm {
  const raw = env.VIGIL_LLM_PROVIDER?.trim().toLowerCase() || "none";
  if (!["none", "gemini", "anthropic", "ollama"].includes(raw)) {
    return { selection: "none", provider: null, modelId: null, keyPresent: false, reason: `VIGIL_LLM_PROVIDER=${raw} is invalid; expected gemini, anthropic, ollama or none.` };
  }
  const selection = raw as RuntimeProvider;
  if (selection === "none") {
    return { selection, provider: null, modelId: null, keyPresent: false, reason: "VIGIL_LLM_PROVIDER is none; deterministic fallback was selected explicitly." };
  }

  try {
    if (selection === "gemini") {
      const keyPresent = Boolean(env.GEMINI_API_KEY);
      if (!keyPresent) throw new Error("GEMINI_API_KEY is not configured.");
      const modelId = env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
      return { selection, provider: createGeminiProvider({ apiKey: env.GEMINI_API_KEY, model: modelId, baseUrl: env.GEMINI_BASE_URL }), modelId, keyPresent, reason: `Gemini ${modelId} is enabled for interactive runs.` };
    }
    if (selection === "anthropic") {
      const keyPresent = Boolean(env.ANTHROPIC_API_KEY);
      if (!keyPresent) throw new Error("ANTHROPIC_API_KEY is not configured.");
      const modelId = env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
      return { selection, provider: createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: modelId, baseUrl: env.ANTHROPIC_BASE_URL }), modelId, keyPresent, reason: `Anthropic ${modelId} is enabled for interactive runs.` };
    }
    const modelId = env.OLLAMA_MODEL ?? "qwen2.5:7b";
    const keyPresent = Boolean(env.OLLAMA_BASE_URL);
    if (!keyPresent) throw new Error("OLLAMA_BASE_URL is not configured.");
    return { selection, provider: createOllamaProvider({ model: modelId, baseUrl: env.OLLAMA_BASE_URL }), modelId, keyPresent, reason: `Ollama ${modelId} is enabled for interactive runs.` };
  } catch (error) {
    return { selection, provider: null, modelId: null, keyPresent: false, reason: error instanceof Error ? error.message : "The selected provider could not be constructed." };
  }
}

export function activeAgentLlm(runtime: RuntimeLlm): AgentLlm {
  return {
    provider: runtime.provider ?? undefined,
    telemetry: createTelemetry(),
    runtime: {
      selection: runtime.selection,
      modelId: runtime.modelId,
      mode: runtime.provider ? "active" : "disabled",
      reason: runtime.reason,
    },
  };
}

export function bootstrapAgentLlm(runtime: RuntimeLlm): AgentLlm {
  const configured = runtime.provider !== null;
  return {
    runtime: {
      selection: runtime.selection,
      modelId: runtime.modelId,
      mode: configured ? "skipped_seed_bootstrap" : "disabled",
      reason: configured
        ? `Model ${runtime.modelId} is configured, but seeded bootstrap deliberately skips model calls to avoid nearly one hundred startup requests.`
        : runtime.reason,
    },
  };
}

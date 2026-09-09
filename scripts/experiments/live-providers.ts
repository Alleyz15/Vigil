import {
  anthropicConfigured,
  checkOllamaAvailability,
  createAnthropicProvider,
  createGeminiProvider,
  createOllamaProvider,
  geminiConfigured,
  ollamaConfigured,
  type LlmProvider,
  type OllamaMetrics,
} from "@/lib/llm";
import { captureCompletion, type CapturedCompletion } from "./llm-live";

export type LiveProvider = {
  family: "gemini" | "anthropic" | "ollama";
  modelId: string;
  provider: LlmProvider;
  warmup?: CapturedCompletion;
  ollamaMetrics: OllamaMetrics[];
};

export async function loadLiveProviders(): Promise<LiveProvider[]> {
  const missing = [
    !geminiConfigured() && "GEMINI_API_KEY",
    !anthropicConfigured() && "ANTHROPIC_API_KEY",
    !ollamaConfigured() && "OLLAMA_BASE_URL",
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`missing live provider configuration: ${missing.join(", ")}`);

  const availability = await checkOllamaAvailability({ timeoutMs: 5_000 });
  if (!availability.available) {
    throw new Error(
      `Ollama model ${availability.model} is not installed; found: ${availability.installed.join(", ") || "none"}`,
    );
  }

  const metrics: OllamaMetrics[] = [];
  const ollama = createOllamaProvider({ onMetrics: (value) => metrics.push(value) });
  const warmup = await captureCompletion(ollama, {
    system: 'Reply with JSON only: {"ok":true}',
    user: "Warm the configured local model.",
    timeoutMs: 90_000,
    temperature: 0,
  });
  if (warmup.error) throw new Error(`Ollama warm-up failed: ${warmup.error}`);
  const warmupMetrics = [...metrics];
  metrics.length = 0;

  return [
    spec("gemini", createGeminiProvider()),
    spec("anthropic", createAnthropicProvider()),
    {
      family: "ollama",
      modelId: modelIdOf(ollama),
      provider: ollama,
      warmup: { ...warmup, provider: ollama.name },
      ollamaMetrics: warmupMetrics,
    },
  ];
}

function spec(family: LiveProvider["family"], provider: LlmProvider): LiveProvider {
  return { family, modelId: modelIdOf(provider), provider, ollamaMetrics: [] };
}

export function modelIdOf(provider: LlmProvider): string {
  return provider.name.slice(provider.name.indexOf(":") + 1);
}

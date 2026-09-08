import type { LlmProvider, LlmRequest } from "../types";
import { callOpenAiCompatible } from "./gemini";

/**
 * Ollama, for the offline demo.
 *
 * A SEAM, NOT A BUILT-OUT PROVIDER. Ollama exposes an OpenAI-compatible
 * endpoint, so this reuses the same call path rather than adding a second one;
 * what is deliberately absent is model selection, pulling, warm-up and the
 * prompt tuning a small local model would need. It is here so "sensitive
 * logistics data never leaves the building" is a configuration change rather
 * than a rewrite, and so the demo survives a dead conference network.
 *
 * Not exercised by the test suite beyond its construction.
 */

export const OLLAMA_BASE_URL_ENV = "OLLAMA_BASE_URL";
export const OLLAMA_MODEL_ENV = "OLLAMA_MODEL";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_MODEL = "llama3.1";

export function ollamaConfigured(): boolean {
  return Boolean(process.env[OLLAMA_BASE_URL_ENV]);
}

export function createOllamaProvider(options: { model?: string; baseUrl?: string } = {}): LlmProvider {
  const model = options.model ?? process.env[OLLAMA_MODEL_ENV] ?? DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? process.env[OLLAMA_BASE_URL_ENV] ?? DEFAULT_BASE_URL;

  return {
    name: `ollama:${model}`,
    // Ollama ignores the bearer token; the endpoint shape is otherwise identical.
    complete: (request: LlmRequest) =>
      callOpenAiCompatible({ apiKey: "ollama", model, baseUrl }, request),
  };
}

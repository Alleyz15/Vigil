import type { LlmProvider, LlmRequest } from "../types";

/**
 * Gemini through its OpenAI-compatible endpoint.
 *
 * The compatible endpoint is used rather than the native SDK so the same
 * provider shape covers any OpenAI-compatible service — including a local one —
 * without a second implementation. The seam is `complete(): Promise<string>`;
 * everything above it parses and validates, so a provider cannot widen what the
 * agent will accept.
 */

export const GEMINI_KEY_ENV = "GEMINI_API_KEY";
export const GEMINI_MODEL_ENV = "GEMINI_MODEL";
export const GEMINI_BASE_URL_ENV = "GEMINI_BASE_URL";
export const GEMINI_REASONING_EFFORT_ENV = "GEMINI_REASONING_EFFORT";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
// Current documented Flash-Lite model as of 2026-09-09. The previous
// gemini-2.0-flash default was shut down on 2026-06-01. Gemini 3.8 was tried
// here first but did not answer within 120 seconds on the configured account;
// 3.5 Flash-Lite is the API's stated replacement for new users and answered at
// minimal effort. Keep this reachable through an offline construction test so
// model retirement or availability cannot hide again.
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

export type GeminiOptions = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
};

/** Whether a key is configured. Used to skip the integration test. */
export function geminiConfigured(): boolean {
  return Boolean(process.env[GEMINI_KEY_ENV]);
}

export function createGeminiProvider(options: GeminiOptions = {}): LlmProvider {
  const apiKey = options.apiKey ?? process.env[GEMINI_KEY_ENV];
  const model = options.model ?? process.env[GEMINI_MODEL_ENV] ?? DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? process.env[GEMINI_BASE_URL_ENV] ?? DEFAULT_BASE_URL;
  const reasoningEffort = resolveReasoningEffort(
    options.reasoningEffort ?? process.env[GEMINI_REASONING_EFFORT_ENV],
    model,
  );

  if (!apiKey) {
    throw new Error(
      `${GEMINI_KEY_ENV} is not set. The agent runs without a model; do not construct this provider unless one is configured.`,
    );
  }

  return {
    name: `gemini:${model}`,
    complete: (request: LlmRequest) =>
      callOpenAiCompatible(
        { apiKey, model, baseUrl, reasoningEffort },
        request,
      ),
  };
}

function resolveReasoningEffort(
  configured: string | undefined,
  model: string,
): "minimal" | "low" | "medium" | "high" {
  if (configured) {
    if (["minimal", "low", "medium", "high"].includes(configured)) {
      return configured as "minimal" | "low" | "medium" | "high";
    }
    throw new Error(`${GEMINI_REASONING_EFFORT_ENV} must be minimal, low, medium or high`);
  }

  // 3.8 rejects minimal; 3.5 Flash-Lite supports it and the live smoke test
  // measured 1.1 s instead of 39.8 s at low for the same tiny JSON response.
  return model === "gemini-3.5-flash-lite" ? "minimal" : "low";
}

/**
 * One completion call.
 *
 * The deadline is enforced with an AbortController rather than a racing
 * promise, so a slow request is actually cancelled instead of being left to
 * finish into a void. A model that has not answered by the deadline has failed,
 * and the caller falls back deterministically.
 */
export async function callOpenAiCompatible(
  config: {
    apiKey: string;
    model: string;
    baseUrl: string;
    /** Gemini 3.8 defaults to medium; these bounded JSON tasks only need low. */
    reasoningEffort?: "minimal" | "low" | "medium" | "high";
  },
  request: LlmRequest,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        temperature: request.temperature ?? 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("the response carried no message content");

    return content;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`timed out after ${request.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_MODEL = "gemini-2.0-flash";

export type GeminiOptions = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

/** Whether a key is configured. Used to skip the integration test. */
export function geminiConfigured(): boolean {
  return Boolean(process.env[GEMINI_KEY_ENV]);
}

export function createGeminiProvider(options: GeminiOptions = {}): LlmProvider {
  const apiKey = options.apiKey ?? process.env[GEMINI_KEY_ENV];
  const model = options.model ?? process.env[GEMINI_MODEL_ENV] ?? DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? process.env[GEMINI_BASE_URL_ENV] ?? DEFAULT_BASE_URL;

  if (!apiKey) {
    throw new Error(
      `${GEMINI_KEY_ENV} is not set. The agent runs without a model; do not construct this provider unless one is configured.`,
    );
  }

  return {
    name: `gemini:${model}`,
    complete: (request: LlmRequest) => callOpenAiCompatible({ apiKey, model, baseUrl }, request),
  };
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
  config: { apiKey: string; model: string; baseUrl: string },
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

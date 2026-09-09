import type { LlmProvider, LlmRequest } from "../types";

export const ANTHROPIC_KEY_ENV = "ANTHROPIC_API_KEY";
export const ANTHROPIC_MODEL_ENV = "ANTHROPIC_MODEL";
export const ANTHROPIC_BASE_URL_ENV = "ANTHROPIC_BASE_URL";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const API_VERSION = "2023-06-01";

export type AnthropicOptions = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

export function anthropicConfigured(): boolean {
  return Boolean(process.env[ANTHROPIC_KEY_ENV]);
}

export function createAnthropicProvider(options: AnthropicOptions = {}): LlmProvider {
  const apiKey = options.apiKey ?? process.env[ANTHROPIC_KEY_ENV];
  const model = options.model ?? process.env[ANTHROPIC_MODEL_ENV] ?? DEFAULT_MODEL;
  const baseUrl = trimTrailingSlash(
    options.baseUrl ?? process.env[ANTHROPIC_BASE_URL_ENV] ?? DEFAULT_BASE_URL,
  );

  if (!apiKey) {
    throw new Error(
      `${ANTHROPIC_KEY_ENV} is not set. Do not construct this provider unless one is configured.`,
    );
  }

  return {
    name: `anthropic:${model}`,
    complete: (request) => callAnthropic({ apiKey, model, baseUrl }, request),
  };
}

export async function callAnthropic(
  config: { apiKey: string; model: string; baseUrl: string },
  request: LlmRequest,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1_024,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      }),
    });

    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

    const body = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const content = body.content
      ?.filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    if (!content) throw new Error("the response carried no text content");
    return content;
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`timed out after ${request.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

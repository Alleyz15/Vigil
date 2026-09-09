import type { LlmProvider, LlmRequest } from "../types";

export const OLLAMA_BASE_URL_ENV = "OLLAMA_BASE_URL";
export const OLLAMA_MODEL_ENV = "OLLAMA_MODEL";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen2.5:7b";

export type OllamaMetrics = {
  model: string;
  totalDurationMs?: number;
  loadDurationMs?: number;
  evalDurationMs?: number;
};

export type OllamaOptions = {
  model?: string;
  baseUrl?: string;
  onMetrics?: (metrics: OllamaMetrics) => void;
};

export type OllamaAvailability = {
  available: boolean;
  model: string;
  installed: string[];
};

export function ollamaConfigured(): boolean {
  return Boolean(process.env[OLLAMA_BASE_URL_ENV]);
}

export function createOllamaProvider(options: OllamaOptions = {}): LlmProvider {
  const model = options.model ?? process.env[OLLAMA_MODEL_ENV] ?? DEFAULT_MODEL;
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? process.env[OLLAMA_BASE_URL_ENV] ?? DEFAULT_BASE_URL,
  );

  return {
    name: `ollama:${model}`,
    complete: (request: LlmRequest) =>
      callOllama({ model, baseUrl, onMetrics: options.onMetrics }, request),
  };
}

/** Check the local registry without implicitly pulling a multi-gigabyte model. */
export async function checkOllamaAvailability(
  options: OllamaOptions & { timeoutMs?: number } = {},
): Promise<OllamaAvailability> {
  const model = options.model ?? process.env[OLLAMA_MODEL_ENV] ?? DEFAULT_MODEL;
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? process.env[OLLAMA_BASE_URL_ENV] ?? DEFAULT_BASE_URL,
  );
  const timeoutMs = options.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const body = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const installed = [
      ...new Set(
        (body.models ?? [])
          .flatMap((entry) => [entry.name, entry.model])
          .filter((value): value is string => Boolean(value)),
      ),
    ].sort();
    return { available: installed.includes(model), model, installed };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function callOllama(
  config: Required<Pick<OllamaOptions, "model" | "baseUrl">> &
    Pick<OllamaOptions, "onMetrics">,
  request: LlmRequest,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);

  try {
    const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        format: "json",
        options: { temperature: request.temperature ?? 0 },
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
    });

    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const body = (await response.json()) as {
      model?: string;
      message?: { content?: string };
      total_duration?: number;
      load_duration?: number;
      eval_duration?: number;
    };
    const content = body.message?.content;
    if (!content) throw new Error("the response carried no message content");

    config.onMetrics?.({
      model: body.model ?? config.model,
      totalDurationMs: nanosToMs(body.total_duration),
      loadDurationMs: nanosToMs(body.load_duration),
      evalDurationMs: nanosToMs(body.eval_duration),
    });
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

/** Accept the old `/v1` shape but always address Ollama's native server root. */
export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function nanosToMs(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value / 1_000_000);
}

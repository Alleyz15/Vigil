import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OLLAMA_BASE_URL_ENV,
  OLLAMA_MODEL_ENV,
  checkOllamaAvailability,
  createOllamaProvider,
} from "./ollama";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("native Ollama provider", () => {
  it("normalizes a server root and requests native JSON mode", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => {
        void _input;
        void _init;
        return new Response(
          JSON.stringify({
            model: "qwen2.5:7b",
            message: { role: "assistant", content: '{"tools":[]}' },
            done: true,
            total_duration: 1_200_000_000,
            load_duration: 100_000_000,
            eval_duration: 800_000_000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const metrics: unknown[] = [];

    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434/v1/",
      model: "qwen2.5:7b",
      onMetrics: (value) => metrics.push(value),
    });
    const raw = await provider.complete({
      system: "system instruction",
      user: "user evidence",
      timeoutMs: 1_000,
      temperature: 0,
    });

    expect(raw).toBe('{"tools":[]}');
    expect(provider.name).toBe("ollama:qwen2.5:7b");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/chat");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "qwen2.5:7b",
      stream: false,
      format: "json",
      options: { temperature: 0 },
      messages: [
        { role: "system", content: "system instruction" },
        { role: "user", content: "user evidence" },
      ],
    });
    expect(metrics).toEqual([
      {
        model: "qwen2.5:7b",
        totalDurationMs: 1_200,
        loadDurationMs: 100,
        evalDurationMs: 800,
      },
    ]);
  });

  it("checks the configured model against the native model registry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ models: [{ name: "qwen2.5:7b", model: "qwen2.5:7b" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(
      checkOllamaAvailability({ baseUrl: "http://localhost:11434", model: "qwen2.5:7b" }),
    ).resolves.toEqual({ available: true, model: "qwen2.5:7b", installed: ["qwen2.5:7b"] });
  });

  it("reports an installed-model mismatch without pulling anything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ models: [{ name: "gemma3", model: "gemma3" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      checkOllamaAvailability({ baseUrl: "http://localhost:11434", model: "qwen2.5:7b" }),
    ).resolves.toEqual({ available: false, model: "qwen2.5:7b", installed: ["gemma3"] });
  });

  it("keeps root URL and model defaults reachable offline", () => {
    const base = process.env[OLLAMA_BASE_URL_ENV];
    const model = process.env[OLLAMA_MODEL_ENV];
    delete process.env[OLLAMA_BASE_URL_ENV];
    delete process.env[OLLAMA_MODEL_ENV];
    try {
      expect(createOllamaProvider().name).toBe("ollama:qwen2.5:7b");
    } finally {
      if (base === undefined) delete process.env[OLLAMA_BASE_URL_ENV];
      else process.env[OLLAMA_BASE_URL_ENV] = base;
      if (model === undefined) delete process.env[OLLAMA_MODEL_ENV];
      else process.env[OLLAMA_MODEL_ENV] = model;
    }
  });

  it("aborts an in-flight local request at the supplied deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      ),
    );

    await expect(
      createOllamaProvider({ baseUrl: "http://localhost:11434" }).complete({
        system: "system",
        user: "user",
        timeoutMs: 5,
      }),
    ).rejects.toThrow("timed out after 5ms");
  });
});

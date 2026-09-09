import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_MODEL_ENV,
  anthropicConfigured,
  createAnthropicProvider,
} from "./anthropic";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Anthropic Messages provider", () => {
  it("uses the Messages API contract and returns all text blocks", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => {
        void _input;
        void _init;
        return new Response(
          JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            content: [
              { type: "text", text: '{"tools":' },
              { type: "text", text: "[]}" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createAnthropicProvider({ apiKey: "test-key" });
    const raw = await provider.complete({
      system: "system instruction",
      user: "user evidence",
      timeoutMs: 1_000,
      temperature: 0.2,
    });

    expect(raw).toBe('{"tools":[]}');
    expect(provider.name).toBe("anthropic:claude-haiku-4-5-20251001");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1_024,
      temperature: 0.2,
      system: "system instruction",
      messages: [{ role: "user", content: "user evidence" }],
    });
  });

  it("keeps the default model reachable without a live key", () => {
    const configured = process.env[ANTHROPIC_MODEL_ENV];
    delete process.env[ANTHROPIC_MODEL_ENV];
    try {
      expect(createAnthropicProvider({ apiKey: "test-key" }).name).toBe(
        "anthropic:claude-haiku-4-5-20251001",
      );
    } finally {
      if (configured === undefined) delete process.env[ANTHROPIC_MODEL_ENV];
      else process.env[ANTHROPIC_MODEL_ENV] = configured;
    }
  });

  it("reports key configuration and refuses construction without one", () => {
    const configured = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(anthropicConfigured()).toBe(false);
      expect(() => createAnthropicProvider()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (configured === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = configured;
    }
  });

  it("aborts an in-flight request at the supplied deadline", async () => {
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
      createAnthropicProvider({ apiKey: "test-key" }).complete({
        system: "system",
        user: "user",
        timeoutMs: 5,
      }),
    ).rejects.toThrow("timed out after 5ms");
  });
});

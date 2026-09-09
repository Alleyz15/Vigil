import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiProvider } from "./gemini";

afterEach(() => vi.unstubAllGlobals());

describe("Gemini request configuration", () => {
  it("uses minimal reasoning effort on the default Flash-Lite model", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => {
        void _input;
        void _init;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"tools":[]}' } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const configured = process.env.GEMINI_MODEL;
    delete process.env.GEMINI_MODEL;
    const provider = createGeminiProvider({ apiKey: "test-key" });
    await provider.complete({ system: "system", user: "user", timeoutMs: 1_000 });
    if (configured === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = configured;

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("minimal");
  });
});

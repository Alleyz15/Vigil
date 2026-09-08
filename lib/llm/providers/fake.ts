import type { LlmProvider } from "../types";

/**
 * Test doubles.
 *
 * These are the providers the parity tests run against: two models that
 * disagree with each other about tools and about wording, so "the verdict does
 * not move" is asserted against genuine disagreement rather than against a
 * single canned answer.
 */

/** Always returns the same text. */
export function fixedProvider(name: string, response: string): LlmProvider {
  return { name, complete: async () => response };
}

/** Throws, as an unreachable endpoint would. */
export function unreachableProvider(message = "ECONNREFUSED"): LlmProvider {
  return {
    name: "unreachable",
    complete: async () => {
      throw new Error(message);
    },
  };
}

/**
 * Never answers within the deadline.
 *
 * Rejects on its own timeout so a test does not hang: a provider that ignores
 * its deadline takes the whole request down with it.
 */
export function hangingProvider(): LlmProvider {
  return {
    name: "hanging",
    complete: ({ timeoutMs }) =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
  };
}

/** Returns something that is not JSON at all. */
export function garbageProvider(): LlmProvider {
  return fixedProvider("garbage", "I'm sorry, I can't help with that request.");
}

/**
 * Answers the plan and explain prompts differently, dispatching on which system
 * prompt it was handed.
 *
 * A real model answers both call sites; a double that only answers one would
 * make the other fall back every time, and a parity test comparing two
 * identical fallbacks proves nothing.
 */
export function scriptedProvider(
  name: string,
  script: { plan?: unknown; explain?: unknown },
): LlmProvider {
  return {
    name,
    complete: async ({ system }) => {
      const forPlan = system.includes("OPTIONAL background checks");
      const payload = forPlan ? script.plan : script.explain;
      if (payload === undefined) return "";
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
  };
}

/** Returns valid JSON that does not satisfy the schema. */
export function schemaViolatingProvider(payload: unknown): LlmProvider {
  return fixedProvider("schema-violating", JSON.stringify(payload));
}

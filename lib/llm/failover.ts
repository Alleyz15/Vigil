import type { LlmProvider } from "./types";

export type ModelAttempt = { modelName?: string; failoverReason?: string };

/** Each attempt is validated as a whole before a second provider is considered. */
export async function withModelFailover<T extends { rejection?: string }>(
  provider: LlmProvider | undefined,
  fallbackProvider: LlmProvider | undefined,
  run: (provider: LlmProvider | undefined) => Promise<T>,
): Promise<T & ModelAttempt> {
  const first = await run(provider);
  if (!provider || !first.rejection || !fallbackProvider) {
    return { ...first, ...(provider ? { modelName: provider.name } : {}) };
  }
  const second = await run(fallbackProvider);
  return {
    ...second,
    modelName: fallbackProvider.name,
    failoverReason: `${provider.name}: ${first.rejection}`,
  };
}

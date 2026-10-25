import { z } from "zod";

/** Approved simulation inputs only. Version is mandatory in persisted data. */
export const RandomSimulationConfig = z.strictObject({
  mode: z.literal("randomized"),
  seed: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  version: z.literal("signals-v1"),
});
export type RandomSimulationConfig = z.infer<typeof RandomSimulationConfig>;

/** Absence means legacy behavior; corrupted configuration must never fall back to normal. */
export function simulationOf(row: { simulationJson?: string | null }): RandomSimulationConfig | undefined {
  if (row.simulationJson == null) return undefined;
  return RandomSimulationConfig.parse(JSON.parse(row.simulationJson));
}

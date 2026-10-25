import type { RandomSimulationConfig } from "@/lib/simulation/config";
import { makeRng } from "../rng";

/** JSON tuples avoid delimiter aliases between seed and stream names. */
export function simulationStream(config: RandomSimulationConfig, name: string) {
  return makeRng(JSON.stringify([config.mode, config.version, config.seed, name]));
}

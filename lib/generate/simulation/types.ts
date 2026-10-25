import type { RandomSimulationConfig } from "@/lib/simulation/config";

export type SimulationCondition = {
  source: "environment" | "behavior";
  code: string;
  label: string;
};

export type HistoryProfile = "normal" | "burst" | "recurring-signals" | "clumped-scans";

export type SimulationHistoryProvenance = {
  source: "simulated";
  runId: string;
  priorHandoffs: number;
  snapshotAt: string;
};

export type SimulationBootstrapProvenance = {
  profile: HistoryProfile;
  bootstrapCount: number;
  from?: string;
  to?: string;
};

/** Ground truth about sampled inputs, never a detector finding or a verdict. */
export type SimulationProvenance = RandomSimulationConfig & {
  conditions: SimulationCondition[];
  history?: SimulationHistoryProvenance;
  bootstrap?: SimulationBootstrapProvenance;
  unavailable?: { code: string; reason: string }[];
};

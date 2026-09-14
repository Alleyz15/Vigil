import { describe, expect, it } from "vitest";
import type { DivergenceCell } from "@/lib/evidence/e4";
import {
  countDivergentCells,
  disclosureId,
  pairwiseAgreementColumns,
} from "./divergence-matrix-model";

const cell = (provider: string, scenario: string, divergesFromEngine: boolean): DivergenceCell => ({
  provider,
  model: `${provider}-model`,
  scenario,
  decision: "accept",
  agreed: 5,
  samples: 5,
  engineDecision: "accept",
  divergesFromEngine,
  rawResponse: '{"decision":"accept"}',
  reasoningOffered: false,
});

describe("divergence matrix model", () => {
  it("counts only cells that differ from the deterministic engine", () => {
    expect(countDivergentCells([
      cell("gemini", "S0", false),
      cell("ollama", "S1", true),
      cell("anthropic", "S6", true),
    ])).toBe(2);
  });

  it("gives every provider and scenario pair a stable disclosure id", () => {
    expect(disclosureId(cell("ollama", "S1", true))).toBe("ollama-S1");
  });

  it("preserves the report scenario order for pairwise agreement", () => {
    expect(pairwiseAgreementColumns([
      { scenario: "S0", meaning: "clean", engineDecision: "accept", pairwiseAgreement: 1, distinctDecisions: 1 },
      { scenario: "S1", meaning: "spoof", engineDecision: "flag", pairwiseAgreement: 1 / 3, distinctDecisions: 2 },
      { scenario: "S6", meaning: "degraded", engineDecision: "accept", pairwiseAgreement: 1 / 3, distinctDecisions: 2 },
    ]).map((column) => column.scenario)).toEqual(["S0", "S1", "S6"]);
  });
});

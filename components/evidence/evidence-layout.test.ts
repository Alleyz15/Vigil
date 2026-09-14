import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DivergenceReport } from "@/lib/evidence/e4";
import { DivergenceMatrix } from "./divergence-matrix";
import { VerifyView } from "../ledger/verify-view";

const report: DivergenceReport = {
  measuredOn: "2026-09-10",
  samplesPerCell: 5,
  scenarios: [
    { scenario: "S0", meaning: "clean", engineDecision: "accept", pairwiseAgreement: 1, distinctDecisions: 1 },
    { scenario: "S1", meaning: "spoof", engineDecision: "flag", pairwiseAgreement: 1 / 3, distinctDecisions: 2 },
    { scenario: "S6", meaning: "degraded", engineDecision: "accept", pairwiseAgreement: 1 / 3, distinctDecisions: 2 },
  ],
  cells: [],
};

function columnGroup(html: string, layout: string): string | undefined {
  return html.match(
    new RegExp(`<table[^>]*data-column-layout="${layout}"[^>]*>\\s*(<colgroup>.*?</colgroup>)`),
  )?.[1];
}

describe("evidence page layout", () => {
  it("keeps the ledger selector content away from its border", () => {
    const html = renderToStaticMarkup(createElement(VerifyView, {
      scenarios: ["S0"],
      summaries: [],
    }));

    expect(html).toMatch(/data-ledger-selector="true"[^>]*style="padding-inline:20px"/);
  });

  it("uses the matrix column tracks for pairwise agreement", () => {
    const html = renderToStaticMarkup(createElement(DivergenceMatrix, { report }));

    expect(columnGroup(html, "matrix")).toBeDefined();
    expect(columnGroup(html, "pairwise")).toBe(columnGroup(html, "matrix"));
  });
});

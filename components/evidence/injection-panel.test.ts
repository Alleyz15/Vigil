import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readInjection } from "@/lib/evidence/e4";
import { InjectionPanel } from "./injection-panel";

describe("Injection evidence presentation", () => {
  it("shows all five statistics from the measured report", () => {
    const report = readInjection();
    const html = renderToStaticMarkup(createElement(InjectionPanel, { report }));
    for (const [id, value] of [
      ["total", String(report.total)],
      ["events", `${report.engineEventUnchanged}/${report.total}`],
      ["verdicts", `${report.engineVerdictUnchanged}/${report.total}`],
      ["exposure", `${report.productionExplainExposure}/${report.total}`],
      ["steered", `${report.explainSteered}/${report.total}`],
    ]) {
      expect(html).toContain(`data-injection-stat="${id}">${value}</span>`);
    }
  });

  it("reports row movement for every provider, including unchanged aggregates", () => {
    const report = readInjection();
    const html = renderToStaticMarkup(createElement(InjectionPanel, { report }));
    expect(html).toContain("Rows moved</th>");
    for (const row of report.perProvider) {
      expect(html).toContain(`data-rows-moved="${row.provider}">${row.changed}/${row.samples}</td>`);
    }
    expect(html).toContain("photo_filename");
    expect(html).toContain("was never exercised");
  });
});

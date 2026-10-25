// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { SimulationProvenance, type SimulationProvenanceProps } from "./simulation-provenance";

afterEach(cleanup);

const provenance: SimulationProvenanceProps = {
  seed: "demo_Seed-42",
  version: "signals-v1",
  conditions: [
    { source: "environment", code: "basement", label: "Basement GPS drift" },
    { source: "behavior", code: "mock-location", label: "Mock location reported" },
  ],
  history: { runId: "courier-run-7", priorHandoffs: 12, source: "simulated", snapshotAt: "2026-10-25T09:00:00Z" },
};

it("labels the simulation in a collapsed native disclosure with readable seed/version and separate condition sources", () => {
  const view = render(createElement(SimulationProvenance, provenance));
  const summary = view.getByText("Simulation provenance");
  const disclosure = summary.closest("details")!;
  expect(disclosure.open).toBe(false);
  expect(summary.closest("summary")).toBeTruthy();
  disclosure.open = true;
  expect(view.getByText("demo_Seed-42")).toBeTruthy();
  expect(view.getByText("signals-v1")).toBeTruthy();
  const environment = view.getByRole("region", { name: "Environmental conditions" });
  const behavior = view.getByRole("region", { name: "Simulated behavior" });
  expect(within(environment).getByText("Basement GPS drift")).toBeTruthy();
  expect(within(environment).queryByText("Mock location reported")).toBeNull();
  expect(within(behavior).getByText("Mock location reported")).toBeTruthy();
  expect(within(behavior).getByText(/mock-location/)).toBeTruthy();
  expect(view.getByText(/sampled conditions.*not detected findings/i)).toBeTruthy();
  expect(view.getByText(/same.*inputs.*version.*courier context/i)).toBeTruthy();
});

it("shows the simulated run boundary, exact prior count and immutable snapshot timestamp", () => {
  const view = render(createElement(SimulationProvenance, provenance));
  expect(view.getByText("Simulated courier history")).toBeTruthy();
  expect(view.getByText("courier-run-7")).toBeTruthy();
  expect(view.getByText("12 prior handoffs")).toBeTruthy();
  const timestamp = view.getByText("2026-10-25T09:00:00Z");
  expect(timestamp.closest("time")?.dateTime).toBe("2026-10-25T09:00:00Z");
  expect(view.getByText(/snapshot.*same.*courier.*run/i)).toBeTruthy();
});

it("reports absent history as unavailable rather than inventing a zero baseline", () => {
  const view = render(createElement(SimulationProvenance, { seed: "S", version: "signals-v1", conditions: [] }));
  expect(view.getByText(/history.*not provided/i)).toBeTruthy();
  expect(view.queryByText(/0 prior handoffs/)).toBeNull();
  expect(view.getByText(/no environmental conditions recorded/i)).toBeTruthy();
  expect(view.getByText(/no simulated behavior recorded/i)).toBeTruthy();
});

it("keeps a supplied zero count distinct from missing history", () => {
  const view = render(createElement(SimulationProvenance, { ...provenance, history: { ...provenance.history!, priorHandoffs: 0 } }));
  expect(view.getByText("0 prior handoffs")).toBeTruthy();
  expect(view.queryByText(/history.*not provided/i)).toBeNull();
});

it("does not let repeated condition codes across sources merge their labels", () => {
  const view = render(createElement(SimulationProvenance, {
    ...provenance,
    conditions: [{ source: "environment", code: "clock", label: "Ordinary drift" }, { source: "behavior", code: "clock", label: "Altered handset clock" }],
  }));
  expect(view.getByText("Ordinary drift")).toBeTruthy();
  expect(view.getByText("Altered handset clock")).toBeTruthy();
});

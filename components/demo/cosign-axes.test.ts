// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { CosignModel } from "@/lib/demo/cosign";
import { CosignSplit } from "./cosign-split";

type Axis = CosignModel["operator"]["inconsistency"];

function rendered(inconsistency: Axis, pattern: Axis) {
  const model: CosignModel = {
    phase: "decided_without_cosignature",
    shared: { source: "seeded", eventId: "event-s4", scenarioId: "S4", waybillNo: "WB-S4",
      epc: "urn:epc:id:sgtin:1", leg: "delivery", eventTime: "2026-10-24T02:00:00Z", eventHash: null },
    courier: { identity: { role: "courier", subject: "CR-1", label: "Courier", keyFingerprint: null },
      attempts: 1, signed: true, headline: "Submitted", detail: "Delivery scan submitted.", problems: [], handoffId: "history:event-s4" },
    operator: { identity: { role: "operator", subject: "OP-1", label: "Operator", keyFingerprint: null },
      queued: true, inconsistency, pattern, coverageLine: "0 of 16 checks evaluable", flags: [], gate: null, canCosign: false },
    credential: null, ledger: { sealed: true, sequence: 1, entries: 1, chainValid: true },
    arithmetic: { headline: "Hard check failed", detail: "No scoring pass was performed." },
  };
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(createElement(CosignSplit, { model, choices: [], selectedHandoffId: "history:event-s4" }));
  return within(root);
}

it("shows hard-aborted zero scores as n/e on both axes while retaining their reasons and coverage", () => {
  const view = rendered(
    { score: 0, evaluable: false, source: "not_evaluated", reason: "hard check failed (OUT_OF_SCOPE)" },
    { score: 0, evaluable: false, source: "not_evaluated", reason: "pattern evidence was unavailable" },
  );
  for (const label of ["Single-event", "Pattern"]) {
    const axis = within(view.getByText(label).parentElement!);
    expect(axis.getByText("n/e")).toBeTruthy();
    expect(axis.queryByText("0")).toBeNull();
  }
  expect(view.getByText("hard check failed (OUT_OF_SCOPE)")).toBeTruthy();
  expect(view.getByText("pattern evidence was unavailable")).toBeTruthy();
  expect(view.getByText("0 of 16 checks evaluable")).toBeTruthy();
});

it.each([
  { score: 0, evaluable: false, source: "cold_start" as const, reason: "Not enough courier history" },
  { score: null, evaluable: false, source: "not_evaluated" as const, reason: "Missing evidence" },
  null,
])("keeps measured zero distinct from an unavailable pattern axis: %j", (pattern) => {
  const view = rendered({ score: 0, evaluable: true, source: "evaluated", reason: null }, pattern);
  const single = within(view.getByText("Single-event").parentElement!);
  expect(single.getByText("0")).toBeTruthy();
  expect(single.queryByText("n/e")).toBeNull();
  expect(within(view.getByText("Pattern").parentElement!).getByText("n/e")).toBeTruthy();
});

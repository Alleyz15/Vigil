import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HandoffSummary } from "@/lib/workbench";
import { HandoffTable } from "./handoff-table";
import { InboxTable } from "./inbox-table";

const ITEM: HandoffSummary = {
  eventId: "event-1",
  caseId: "case-1",
  scenarioId: "S1",
  legIndex: 5,
  parcel: { epc: "urn:epc:id:sgtin:1", waybillNo: "WB-2026-10001" },
  courier: { courierId: "CR-1000", displayName: "Aiman Tan" },
  bizStep: "delivering",
  eventTime: "2026-09-08T10:00:00+08:00",
  state: "awaiting_cosignature",
  priority: 400,
  reason: "Single-event evidence is high.",
  ageMinutes: 12,
  decision: null,
  sealed: false,
  inconsistency: { score: 100, evaluable: true, source: "evaluated", reason: null },
  pattern: { score: 0, evaluable: true, source: "evaluated", reason: null },
  coverageLine: "14 of 16 checks evaluable",
  gateBasis: "both_axes",
  requiresCosign: true,
  provenance: {
    event: "synthetic",
    attestation: "mocked",
    pattern: "evaluated",
    explanation: { source: "fallback", modelId: null },
  },
};

describe("operator work lists", () => {
  it("renders the queue as work with both axes separate and nothing-sealed state explicit", () => {
    const html = renderToStaticMarkup(createElement(InboxTable, { items: [ITEM] }));

    expect(html).toContain("Single-event");
    expect(html).toContain("Pattern");
    expect(html).toContain("Nothing sealed");
    expect(html).not.toContain("Combined");
  });

  it("states the automatic-accept numerator, denominator and timeframe and exposes gate basis", () => {
    const accepted = { ...ITEM, state: "accepted" as const, decision: "accept", sealed: true };
    const html = renderToStaticMarkup(
      createElement(HandoffTable, {
        items: [accepted],
        summary: {
          automaticallyAccepted: 1,
          total: 1,
          timeframe: "2026-09-08T10:00:00.000Z to 2026-09-08T12:00:00.000Z",
          from: "2026-09-08T10:00:00.000Z",
          to: "2026-09-08T12:00:00.000Z",
        },
      }),
    );

    expect(html).toContain("1 of 1 handoffs automatically accepted");
    expect(html).toMatch(/8 Sep(?:t)? 2026/);
    expect(html).toContain("both axes");
  });
});

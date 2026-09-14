import { describe, expect, it } from "vitest";
import type { HandoffSummary } from "@/lib/workbench";
import {
  detailHref,
  filterAndSortHandoffs,
  handoffBackLink,
  workspaceMetrics,
} from "./handoffs-workspace-model";

const BASE: HandoffSummary = {
  eventId: "event-1",
  caseId: "case-1",
  scenarioId: "S1",
  legIndex: 5,
  parcel: {
    epc: "urn:epc:id:sgtin:1",
    waybillNo: "WB-2026-10001",
    idKind: "waybill",
    onThisShipment: true,
  },
  courier: { courierId: "CR-1000", displayName: "Aiman Tan" },
  bizStep: "delivering",
  eventTime: "2026-09-08T10:00:00+08:00",
  state: "awaiting_cosignature",
  priority: 400,
  reason: "Single-event evidence is high.",
  shortReason: "GPS contradicts cell",
  matrixCell: "high-single/low-pattern",
  abort: null,
  inboxGroup: "waiting",
  stateProvenance: "computed",
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

describe("combined operator handoff workspace model", () => {
  it("derives metrics from the supplied backend records", () => {
    const refused = {
      ...BASE,
      eventId: "event-2",
      state: "flagged" as const,
      abort: "hard_check" as const,
      inboxGroup: "refused" as const,
    };
    const accepted = {
      ...BASE,
      eventId: "event-3",
      state: "accepted" as const,
      decision: "accept",
      sealed: true,
      inboxGroup: "other" as const,
      matrixCell: "low-single/low-pattern",
    };
    const pattern = {
      ...BASE,
      eventId: "event-4",
      state: "flagged" as const,
      inboxGroup: "pattern" as const,
      matrixCell: "low-single/high-pattern",
    };

    expect(workspaceMetrics([BASE, refused, pattern], [BASE, refused, accepted, pattern])).toEqual({
      queue: 3,
      accepted: 1,
      total: 4,
      refused: 1,
      waiting: 1,
      patternCouriers: 1,
    });
  });

  it("searches backend identifiers and preserves backend priority order", () => {
    const higher = {
      ...BASE,
      eventId: "event-2",
      priority: 900,
      courier: { courierId: "CR-2000", displayName: "Zulkifli binti Abdullah" },
      parcel: { ...BASE.parcel, waybillNo: "WB-2026-300007" },
    };

    expect(filterAndSortHandoffs([BASE, higher], "zulkifli").map((item) => item.eventId)).toEqual(["event-2"]);
    expect(filterAndSortHandoffs([BASE, higher], "").map((item) => item.eventId)).toEqual(["event-2", "event-1"]);
  });

  it("carries only the real inbox/all origin into detail navigation", () => {
    expect(detailHref("event/1", "inbox")).toBe("/operator/handoffs/event%2F1?from=inbox");
    expect(handoffBackLink("all")).toEqual({ href: "/operator/handoffs", label: "Back to all handoffs" });
    expect(handoffBackLink("anything-else")).toEqual({ href: "/operator/inbox", label: "Back to inbox" });
  });
});

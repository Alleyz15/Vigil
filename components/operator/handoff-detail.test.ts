import { describe, expect, it } from "vitest";
import { OperatorActionName } from "@/lib/workbench/types";
import {
  detailStatusMessage,
  ledgerReferencePresentation,
  operatorActionAvailability,
  shouldShowEvidenceDetails,
  traceNodeStates,
} from "./handoff-detail-model";

describe("correlated handoff detail presentation", () => {
  it("states that a co-signature halt sealed nothing", () => {
    expect(detailStatusMessage({ state: "awaiting_cosignature", sealed: false })).toEqual({
      title: "Waiting for operator co-signature",
      detail: "Nothing was sealed. Approval reruns the identical event with a complete credential.",
      tone: "pending",
    });
  });

  /**
   * "Response window expired" asserts a window was measured. S5's timed_out is
   * assigned by scenario id and no liveness timer exists, so a seeded state must
   * not say it — and a computed one, if one ever exists, still may.
   */
  it("never claims a response window expired when the timed-out state was seeded", () => {
    const seeded = detailStatusMessage({ state: "timed_out", sealed: false, stateProvenance: "seeded" });
    expect(seeded.title).not.toMatch(/window expired/i);
    expect(seeded.detail).toMatch(/no liveness timer/);

    const computed = detailStatusMessage({ state: "timed_out", sealed: false, stateProvenance: "computed" });
    expect(computed.title).toBe("Response window expired");
  });

  it("derives one ordered node state from the frozen trace without changing the contract", () => {
    const nodes = traceNodeStates([
      { type: "tool_start", seq: 0, at: "2026-09-08T10:00:00+08:00", node: "parse" },
      { type: "tool_end", seq: 1, at: "2026-09-08T10:00:00+08:00", node: "parse", durationMs: 2 },
      { type: "tool_start", seq: 2, at: "2026-09-08T10:00:00+08:00", node: "lookup" },
    ]);

    expect(nodes[0]).toMatchObject({ node: "parse", status: "done", durationMs: 2 });
    expect(nodes[1]).toMatchObject({ node: "lookup", status: "running" });
    expect(nodes.at(-1)).toMatchObject({ node: "explain", status: "pending" });
  });

  it("exposes exactly the actions accepted by the operator API", () => {
    const availability = operatorActionAvailability({
      state: "awaiting_cosignature",
      rerouteAvailable: false,
    });

    expect(Object.keys(availability).sort()).toEqual([...OperatorActionName.options].sort());
    expect(availability).toEqual({
      approve: true,
      reject: true,
      request_evidence: true,
      propose_reroute: false,
      escalate: true,
    });
  });

  it("renders an unwritten ledger position as status, never as a copy action", () => {
    expect(ledgerReferencePresentation(null)).toEqual({
      label: "Not written",
      copyable: false,
    });
    expect(ledgerReferencePresentation(19)).toEqual({
      label: "Ledger #19",
      copyable: true,
    });
  });

  it("does not reserve an empty evidence column for a hard rejection", () => {
    expect(shouldShowEvidenceDetails({ flagCount: 0, hasAddressCorrection: false })).toBe(false);
    expect(shouldShowEvidenceDetails({ flagCount: 1, hasAddressCorrection: false })).toBe(true);
    expect(shouldShowEvidenceDetails({ flagCount: 0, hasAddressCorrection: true })).toBe(true);
  });
});

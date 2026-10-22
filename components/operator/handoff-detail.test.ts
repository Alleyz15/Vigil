import { describe, expect, it } from "vitest";
import { OperatorActionName } from "@/lib/workbench/types";
import {
  acceptanceExplanation,
  attemptHistoryLabel,
  citationTarget,
  detailStatusMessage,
  ledgerReferencePresentation,
  operatorActionAvailability,
  planPresentation,
  primaryFlagCard,
  resolvedActionMessage,
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
    // A clean online delivery has no flags, and still has something to say about its location.
    expect(shouldShowEvidenceDetails({ flagCount: 0, hasAddressCorrection: false, hasLocationGap: true })).toBe(true);
  });

  it("takes a multi-flag status card's id, label and evidence from one rule", () => {
    const card = primaryFlagCard([
      { id: "I1", label: "GPS and registered cell disagree", points: 40, evidence: [{ field: "cellId", value: "cell-1" }] },
      { id: "I7", label: "Mock location reported", points: 50, evidence: [{ field: "mockLocation", value: true }] },
    ]);

    expect(card).toEqual({
      code: "I7",
      title: "Mock location reported",
      evidence: { field: "mockLocation", value: true },
    });
  });

  it("states whether a resolved work item actually has a sealed verdict", () => {
    expect(resolvedActionMessage(true)).toMatch(/sealed deterministic verdict remains unchanged/i);
    expect(resolvedActionMessage(false)).toMatch(/no verdict was sealed/i);
    expect(resolvedActionMessage(false)).not.toMatch(/sealed verdict remains unchanged/i);
  });

  it("explains an acceptance only from the measured axes, mandate condition and credential", () => {
    expect(acceptanceExplanation({
      decision: "accept",
      inconsistencyScore: 0,
      inconsistencyCoverage: "13 of 16 checks evaluable",
      patternScore: 0,
      patternCoverage: "3 of 5 checks evaluable",
      declaredValueSen: 18_000,
      valueThresholdSen: 40_000,
      courierSignatureValid: true,
      requiresCosign: false,
    })).toBe(
      "13 of 16 single-event checks and 3 of 5 pattern checks were evaluable. " +
      "No single-event contradiction was found, recent courier behaviour was normal, " +
      "and RM\u00a0180.00 did not trigger the RM\u00a0400.00 value condition. " +
      "The courier signature was valid; no operator signature was required.",
    );
  });

  it("describes a duplicate no-op as attempt history, not a replacement verdict", () => {
    expect(attemptHistoryLabel({ ledgerStatus: "noop", decision: "accept" })).toEqual({
      title: "Identical resubmission",
      detail: "Original sealed verdict reused. No additional ledger record written.",
    });
  });

  it("does not present unverified model planning prose as an evidence-grounded reason", () => {
    expect(planPresentation({
      source: "model",
      selectedTools: [],
      runtimeReason: null,
    })).toBe(
      "The model selected no optional tools. Its free-text planning rationale is not used as evidence; the auditable deterministic comparison appears below.",
    );
  });

  it("routes explanation citations to the section that owns the cited fact", () => {
    expect(citationTarget("decision")).toEqual({ href: "#decision-and-credential", evidenceId: null });
    expect(citationTarget("credential")).toEqual({ href: "#decision-and-credential", evidenceId: null });
    expect(citationTarget("coverage")).toEqual({ href: "#decision-and-credential", evidenceId: null });
    expect(citationTarget("ledger")).toEqual({ href: "#seal-and-ledger", evidenceId: null });
    expect(citationTarget("I1")).toEqual({ href: "#evidence-details", evidenceId: "I1" });
  });
});

import { describe, expect, it } from "vitest";
import { isQueueState, transitionCase } from "./state";

describe("operator case transitions", () => {
  it("keeps only actionable triage states in the inbox", () => {
    expect(isQueueState("flagged")).toBe(true);
    expect(isQueueState("awaiting_cosignature")).toBe(true);
    expect(isQueueState("timed_out")).toBe(true);
    expect(isQueueState("awaiting_evidence")).toBe(false);
    expect(isQueueState("resolved_approved")).toBe(false);
  });

  it("resolves an awaiting co-signature only through approval", () => {
    expect(transitionCase("awaiting_cosignature", "approve")).toBe("resolved_approved");
    expect(() => transitionCase("flagged", "approve")).toThrow(/cannot approve/i);
  });

  it("records rejection as a disposition rather than a verdict edit", () => {
    expect(transitionCase("flagged", "reject")).toBe("resolved_rejected");
    expect(transitionCase("timed_out", "reject")).toBe("resolved_rejected");
  });

  it("moves requested evidence out of the active queue", () => {
    expect(transitionCase("flagged", "request_evidence")).toBe("awaiting_evidence");
  });

  it("leaves a reroute awaiting its constitutive signatures", () => {
    expect(transitionCase("flagged", "propose_reroute")).toBe(
      "awaiting_reroute_signatures",
    );
  });

  it("does not reopen a terminal case", () => {
    expect(() => transitionCase("resolved_rejected", "request_evidence")).toThrow(
      /already resolved/i,
    );
  });
});

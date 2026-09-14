import { describe, expect, it } from "vitest";
import { getOperatorShellCopy } from "./app-shell-model";

describe("getOperatorShellCopy", () => {
  it("uses the gate-specific title and evidence description", () => {
    expect(getOperatorShellCopy("/demo/gate")).toEqual({
      title: "Gate evidence",
      description:
        "Orthogonal gate evidence: two axes, never summed, with unevaluated points outside the numeric scale.",
    });
  });

  it("keeps the combined handoff shell copy on handoff routes", () => {
    expect(getOperatorShellCopy("/operator/handoffs/example")).toEqual({
      title: "Operator handoffs",
      description: "Inbox and all handoffs share one table. The URL selects the working mode.",
    });
  });

  it("uses the ledger-specific verification claim", () => {
    expect(getOperatorShellCopy("/verify")).toEqual({
      title: "Verify ledger",
      description:
        "Recompute the audit trail in-browser from raw JSONL. The server does not return a verdict.",
    });
  });

  it("uses the measured E4a claim for model divergence", () => {
    expect(getOperatorShellCopy("/demo/models")).toEqual({
      title: "Model divergence",
      description:
        "Measured E4a evidence: model families can be stable within themselves and still disagree with each other.",
    });
  });
});

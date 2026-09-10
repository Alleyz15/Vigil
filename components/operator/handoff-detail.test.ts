import { describe, expect, it } from "vitest";
import { detailStatusMessage, traceNodeStates } from "./handoff-detail-model";

describe("correlated handoff detail presentation", () => {
  it("states that a co-signature halt sealed nothing", () => {
    expect(detailStatusMessage({ state: "awaiting_cosignature", sealed: false })).toEqual({
      title: "Waiting for operator co-signature",
      detail: "Nothing was sealed. Approval reruns the identical event with a complete credential.",
      tone: "pending",
    });
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
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalHash } from "@/lib/ledger";
import { verdicts } from "@/lib/db/schema";
import { createWorkbench, type OperatorWorkbench } from "./service";

describe("stateful operator workbench", () => {
  let workbench: OperatorWorkbench;

  beforeAll(async () => {
    workbench = await createWorkbench({ scenarioIds: ["S0", "S1", "S4"] });
  }, 30_000);

  afterAll(() => workbench.close());

  it("sorts actionable work by priority and leaves accepted handoffs out", () => {
    const queue = workbench.listQueue();

    expect(queue.length).toBeGreaterThan(0);
    expect(queue.every((item) => item.state !== "accepted")).toBe(true);
    expect(queue.map((item) => item.priority)).toEqual(
      [...queue.map((item) => item.priority)].sort((a, b) => b - a),
    );
    expect(queue.some((item) => item.state === "awaiting_cosignature")).toBe(true);
  });

  it("reports the automatic-accept numerator, denominator and fixed timeframe", () => {
    const result = workbench.listHandoffs();

    expect(result.summary.total).toBe(result.items.length);
    expect(result.summary.automaticallyAccepted).toBeGreaterThan(0);
    expect(result.summary.automaticallyAccepted).toBeLessThanOrEqual(result.summary.total);
    expect(result.summary.timeframe).toMatch(/2026/);
    expect(result.items.find((item) => item.decision === "accept")?.gateBasis).toBeTruthy();
  });

  it("serves the shipment route and evidence geometry with the correlated detail", () => {
    const s1 = workbench.listQueue().find((item) => item.scenarioId === "S1")!;
    const detail = workbench.getHandoff(s1.eventId)!;

    expect(detail.map.route).toHaveLength(6);
    expect(detail.map.overlays.some((feature) => feature.evidenceId === "I1")).toBe(true);
  });

  it("approves by rerunning the byte-identical event with a complete sidecar", async () => {
    const pending = workbench
      .listQueue()
      .find((item) => item.state === "awaiting_cosignature")!;
    const before = workbench.getHandoff(pending.eventId)!;
    const beforeHash = canonicalHash(before.event);

    const after = await workbench.resolveHandoff(pending.eventId, { action: "approve" });

    expect(after.summary.state).toBe("resolved_approved");
    expect(after.summary.sealed).toBe(true);
    expect(after.runs).toHaveLength(2);
    expect(after.runs[0].eventHash).toBe(beforeHash);
    expect(after.runs[1].eventHash).toBe(beforeHash);
    expect(after.runs[1].credential).toMatchObject({ courierValid: true, operatorValid: true });
    expect(workbench.listQueue().some((item) => item.eventId === pending.eventId)).toBe(false);
  });

  it("never lets an operator rejection mutate the sealed verdict", async () => {
    const sealed = workbench.listQueue().find((item) => item.scenarioId === "S4")!;
    const handle = workbench.debugHandle(sealed.eventId);
    const before = handle.db.select().from(verdicts).all();

    const detail = await workbench.resolveHandoff(sealed.eventId, {
      action: "reject",
      note: "Return to sender",
    });
    const after = handle.db.select().from(verdicts).all();

    expect(detail.summary.state).toBe("resolved_rejected");
    expect(after).toEqual(before);
    expect(detail.actions.at(-1)).toMatchObject({ action: "reject", note: "Return to sender" });
  });
});

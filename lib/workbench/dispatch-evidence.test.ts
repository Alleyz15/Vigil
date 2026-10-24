import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedDb } from "@/lib/db/migrate";
import { canonicalHash } from "@/lib/ledger";
import { createWorkbench, type OperatorWorkbench } from "./service";

const request = {
  origin: { latitude: 3.13, longitude: 101.67, addressClaim: "Sender reference" },
  destination: { latitude: 3.165, longitude: 101.73, addressClaim: "Confirmed destination" },
  declaredValueSen: 90_000,
  recipientChannel: "+60111234567",
  demoCondition: "mock_location" as const,
};
let wb: OperatorWorkbench;
beforeAll(async () => {
  wb = await createWorkbench({ scenarioIds: ["S0"], courierDrafts: true });
  wb.configureOnline({ store: createMigratedDb(":memory:"), boundary: {
    version: "test", source: "fixture", licence: "n/a",
    area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [
      [[101.6, 3.1], [101.76, 3.1], [101.76, 3.2], [101.6, 3.2], [101.6, 3.1]],
    ] } },
  } });
}, 120_000);
afterAll(() => wb?.close());

async function pending(key: string) {
  const result = await wb.createOnlineShipment(request, key, { awaitAssignment: true });
  if (result.status !== "created") throw new Error(result.status);
  return { shipmentId: result.shipmentId, dispatchId: `online:${result.shipmentId}`, result };
}

describe("manual assignment and evidence review at the workbench boundary", () => {
  it("does not invent scans or give an unassigned sender shipment to a courier", async () => {
    const { result, dispatchId } = await pending("unassigned");
    expect(result).toMatchObject({ running: false, awaitingAssignment: true, eventIds: [] });
    expect(wb.dispatchWorkspace().couriers.map((c) => c.subject)).toEqual(["CR-1000", "CR-1001", "CR-1002", "CR-1003"]);
    expect(wb.dispatchWorkspace().items.find((i) => i.dispatchId === dispatchId)?.state).toBe("awaiting_assignment");
    for (const id of ["CR-1000", "CR-1001", "CR-1002", "CR-1003"]) {
      expect(wb.courierWorkspace(id).items.some((i) => i.handoffId === dispatchId)).toBe(false);
    }
    await expect(wb.submitCourierHandoff(dispatchId, { signed: true, courierId: "CR-1001" })).rejects.toThrow(/assign/i);
  });

  it("assigns all four couriers with matching mandate scope and real handoff fingerprints", async () => {
    for (const courierId of ["CR-1000", "CR-1001", "CR-1002", "CR-1003"]) {
      const { dispatchId } = await pending(`assign-${courierId}`);
      await wb.assignDispatch(dispatchId, courierId);
      const item = wb.courierWorkspace(courierId).items.find((i) => i.handoffId === dispatchId)!;
      expect(item?.courierId).toBe(courierId);
      expect(item.identity?.subject).toBe(courierId);
      expect(item.identity?.keyFingerprint).toMatch(/^ed25519:/);
      const result = await wb.submitCourierHandoff(dispatchId, { signed: true, courierId });
      const detail = wb.getHandoff(result.item.eventId)!;
      expect(detail.flags.map((f) => f.id)).not.toContain("H2");
      expect(detail.flags.map((f) => f.id)).toContain("I7");
      expect(detail.summary.inconsistency.score).toBe(50);
      await expect(wb.assignDispatch(dispatchId, "CR-1001")).rejects.toThrow(/already assigned/i);
    }
  }, 120_000);

  it("refuses a different demo courier instead of signing with the shipment owner's key", async () => {
    const { dispatchId } = await pending("wrong-owner");
    await wb.assignDispatch(dispatchId, "CR-1002");
    await expect(wb.submitCourierHandoff(dispatchId, { signed: true, courierId: "CR-1000" })).rejects.toThrow(/assigned courier/i);
    expect(() => wb.courierWorkspace("CR-NOT-REAL")).toThrow(/unknown courier/i);
  });

  it("keeps registered-address scans inside the chosen courier scope and preserves the out-of-scope fault", async () => {
    for (const [courierId, fault] of [["CR-1000", "none"], ["CR-1003", "out_of_scope"]] as const) {
      const queued = wb.queueRegisteredShipment({ originIndex: 0, destinationIndex: 20, declaredValueSen: 90_000,
        recipientChannel: "+60119990003", fault });
      if (!queued.ok) throw new Error(queued.reason);
      const handoffId = `registered:${queued.runId}`;
      await wb.assignDispatch(handoffId, courierId);
      const submitted = await wb.submitCourierHandoff(handoffId, { signed: true, courierId });
      const detail = wb.getHandoff(submitted.item.eventId)!;
      if (fault === "none") expect(detail.flags.map((flag) => flag.id)).not.toContain("H2");
      else {
        expect(detail.flags.map((flag) => flag.id)).toContain("H2");
        expect(detail.summary.decision).toBe("freeze");
        const requested = await wb.resolveHandoff(submitted.item.eventId, { action: "request_evidence", note: "Explain this out-of-scope scan." });
        await wb.submitEvidence(requested.supportingEvidence![0].requestId, { courierId, submissionId: "hard-stop-reply", explanation: "Supporting material cannot override the scope refusal.", files: [] });
        expect(wb.getHandoff(submitted.item.eventId)!.canApprove).toBe(false);
        await expect(wb.resolveHandoff(submitted.item.eventId, { action: "approve" })).rejects.toThrow(/hard stop/i);
        await wb.resolveHandoff(submitted.item.eventId, { action: "reject" });
        await expect(wb.submitEvidence(requested.supportingEvidence![0].requestId, { courierId, submissionId: "late-reply", explanation: "Too late", files: [] })).rejects.toThrow(/closed|resolved/i);
      }
    }
  }, 120_000);

  it("does not allow another tab to reject or request evidence while approval is sealing", async () => {
    const { dispatchId } = await pending("concurrent-review");
    await wb.assignDispatch(dispatchId, "CR-1000");
    const submitted = await wb.submitCourierHandoff(dispatchId, { signed: true, courierId: "CR-1000" });
    const eventId = submitted.item.eventId;
    const approving = wb.resolveHandoff(eventId, { action: "approve" });
    await expect(wb.resolveHandoff(eventId, { action: "reject" })).rejects.toThrow(/in progress/i);
    await approving;
    expect(wb.getHandoff(eventId)!.summary.state).toBe("resolved_approved");
  });

  it("archives evidence from an earlier workflow instance instead of attaching it to regenerated seeded events", async () => {
    const store = createMigratedDb(":memory:");
    const first = await createWorkbench({ scenarioIds: ["S1"] });
    const fresh = await createWorkbench({ scenarioIds: ["S1"] });
    first.configureOnline({ store, boundary: null });
    fresh.configureOnline({ store, boundary: null });
    try {
      const eventId = first.listQueue()[0].eventId;
      const before = await first.resolveHandoff(eventId, { action: "request_evidence", note: "Original instance request." });
      const roundId = before.supportingEvidence![0].requestId;
      expect(canonicalHash(first.getHandoff(eventId)!.event)).toBe(canonicalHash(fresh.getHandoff(eventId)!.event));
      expect(fresh.getHandoff(eventId)!.supportingEvidence).toEqual([]);
      expect(fresh.getHandoff(eventId)!.archivedEvidenceCount).toBe(1);
      const current = await fresh.resolveHandoff(eventId, { action: "request_evidence", note: "New instance request." });
      expect(current.supportingEvidence).toHaveLength(1);
      expect(current.supportingEvidence![0].note).toBe("New instance request.");
      await expect(fresh.submitEvidence(roundId, { courierId: "CR-1001", submissionId: "old-workflow", explanation: "Old reply", files: [] })).rejects.toThrow(/earlier|instance/i);
    } finally { first.close(); fresh.close(); }
  }, 120_000);

  it("returns submitted evidence to the inbox without changing event bytes, scores or the nonce ledger", async () => {
    const { dispatchId } = await pending("evidence-rounds");
    await wb.assignDispatch(dispatchId, "CR-1003");
    const submitted = await wb.submitCourierHandoff(dispatchId, { signed: true, courierId: "CR-1003" });
    const eventId = submitted.item.eventId;
    const original = wb.getHandoff(eventId)!;
    const hash = canonicalHash(original.event);
    await expect(wb.resolveHandoff(eventId, { action: "request_evidence", note: " " })).rejects.toThrow(/describe|note|request/i);
    const requested = await wb.resolveHandoff(eventId, { action: "request_evidence", note: "Explain the reported mock location." });
    const round = requested.supportingEvidence![0];
    expect(wb.courierWorkspace("CR-1003").evidenceRequests?.some((r) => r.request.requestId === round.requestId)).toBe(true);
    expect(wb.courierWorkspace("CR-1000").evidenceRequests?.some((r) => r.request.requestId === round.requestId)).toBe(false);
    await expect(wb.submitEvidence(round.requestId, {
      courierId: "CR-1000", submissionId: "wrong", explanation: "My photo", files: [],
    })).rejects.toThrow(/assigned courier/i);
    await wb.submitEvidence(round.requestId, {
      courierId: "CR-1003", submissionId: "reply-1", explanation: "Please review the attached supporting material.",
      files: [{ name: "receipt.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF") }],
    });
    const reviewed = wb.getHandoff(eventId)!;
    expect(reviewed.summary.state).toBe("evidence_submitted");
    expect(wb.listQueue().some((i) => i.eventId === eventId)).toBe(true);
    expect(canonicalHash(reviewed.event)).toBe(hash);
    expect(reviewed.summary.inconsistency.score).toBe(original.summary.inconsistency.score);
    expect(reviewed.verdictHash).toBe(original.verdictHash);
    expect(reviewed.runs).toHaveLength(original.runs.length);
    expect(reviewed.canApprove).toBe(true);
    const file = reviewed.supportingEvidence![0].submission!.attachments[0];
    expect(wb.evidenceAttachment(file.attachmentId, { courierId: "CR-1003" }).bytes.toString()).toContain("%PDF");
    expect(() => wb.evidenceAttachment(file.attachmentId, { courierId: "CR-1000" })).toThrow(/assigned courier/i);
    await wb.submitEvidence(round.requestId, {
      courierId: "CR-1003", submissionId: "reply-1", explanation: "Please review the attached supporting material.",
      files: [{ name: "receipt.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF") }],
    });
    expect(wb.getHandoff(eventId)!.supportingEvidence).toHaveLength(1);
    const more = await wb.resolveHandoff(eventId, { action: "request_evidence", note: "Please clarify who captured this file." });
    expect(more.supportingEvidence).toHaveLength(2);
    await expect(wb.resolveHandoff(eventId, { action: "approve" })).rejects.toThrow(/evidence|approve/i);
    await wb.submitEvidence(more.supportingEvidence![1].requestId, {
      courierId: "CR-1003", submissionId: "reply-2", explanation: "Captured by the courier; uploaded as supporting material only.", files: [],
    });
    const approved = await wb.resolveHandoff(eventId, { action: "approve", note: "Reviewed both responses; retaining the I7 finding." });
    expect(approved.summary.sealed).toBe(true);
    expect(approved.summary.decision).toBe("flag");
    expect(approved.flags.map((f) => f.id)).toContain("I7");
    expect(canonicalHash(approved.event)).toBe(hash);
    expect(approved.supportingEvidence).toHaveLength(2);
    await expect(wb.submitEvidence(round.requestId, {
      courierId: "CR-1003", submissionId: "late", explanation: "Late response", files: [],
    })).rejects.toThrow(/resolved|closed/i);
  }, 120_000);
});

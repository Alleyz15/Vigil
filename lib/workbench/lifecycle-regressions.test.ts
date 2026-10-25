import { afterAll, beforeAll, expect, it } from "vitest";
import { createMigratedDb } from "@/lib/db/migrate";
import { resolveRuntimeLlm } from "@/lib/llm/runtime";
import { canonicalHash } from "@/lib/ledger";
import { createWorkbench, type OperatorWorkbench } from "./service";

let wb: OperatorWorkbench;
beforeAll(async () => {
  wb = await createWorkbench({ scenarioIds: ["S0", "S1"], courierDrafts: true,
    runtimeLlm: resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "none" }) });
  wb.configureOnline({ store: createMigratedDb(":memory:"), boundary: {
    version: "lifecycle-test", source: "fixture", licence: "n/a",
    area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [
      [[101.6, 3.1], [101.76, 3.1], [101.76, 3.2], [101.6, 3.2], [101.6, 3.1]],
    ] } },
  } });
}, 120_000);
afterAll(() => wb?.close());

async function online(key: string, value = 90_000) {
  const result = await wb.createOnlineShipment({ origin: { latitude: 3.13, longitude: 101.67 },
    destination: { latitude: 3.165, longitude: 101.73 }, declaredValueSen: value,
    recipientChannel: "+60110000000" }, key, { awaitAssignment: true });
  if (result.status !== "created") throw new Error(result.status);
  const handoffId = `online:${result.shipmentId}`;
  await wb.assignDispatch(handoffId, "CR-1002");
  return wb.submitCourierHandoff(handoffId, { signed: true, courierId: "CR-1002" });
}

it("issues a recipient capability after a new delivery auto-seals and reuses it on retry", async () => {
  const submitted = await online("lifecycle-auto", 18_000);
  const eventId = submitted.item.eventId;
  const original = wb.getHandoff(eventId)!;
  expect(original.summary.sealed).toBe(true);
  expect(original.recipientConfirmation?.state.status).toBe("open");
  const token = original.recipientConfirmation!.tokenId;
  const hash = canonicalHash(original.event);
  await wb.submitCourierHandoff(submitted.item.handoffId, { signed: true, courierId: "CR-1002" });
  expect(wb.confirmationFor(eventId)?.tokenId).toBe(token);
  expect(wb.answerConfirmation(token, "not_received").ok).toBe(true);
  expect(wb.getConfirmation(token).state.status).toBe("answered");
  expect(canonicalHash(wb.getHandoff(eventId)!.event)).toBe(hash);
  expect(wb.getHandoff(eventId)!.ledger.sequence).toBe(original.ledger.sequence);
});

it("issues no capability while pending but creates one after an online operator approval", async () => {
  const submitted = await online("lifecycle-cosign");
  expect(wb.getHandoff(submitted.item.eventId)!.recipientConfirmation).toBeNull();
  const approved = await wb.resolveHandoff(submitted.item.eventId, { action: "approve" });
  expect(approved.recipientConfirmation?.state.status).toBe("open");
  const item = wb.courierWorkspace("CR-1002").items.find((row) => row.eventId === submitted.item.eventId)!;
  expect(item.currentRun?.sealed).toBe(true);
  expect(item.currentRun?.credential?.operatorValid).toBe(true);
  expect(item.state).toBe("resolved_approved");
  expect(item.attempts.at(-1)?.outcome.sealed).toBe(false);
});

it("creates capabilities for seeded and registered deliveries when they are newly sealed", async () => {
  const seeded = wb.courierWorkspace("CR-1001").items.find((row) => row.source === "seeded")!;
  await wb.submitCourierHandoff(seeded.handoffId, { signed: true, courierId: "CR-1001" });
  expect((await wb.resolveHandoff(seeded.eventId, { action: "approve" })).recipientConfirmation).not.toBeNull();
  const queued = wb.queueRegisteredShipment({ originIndex: 0, destinationIndex: 20,
    declaredValueSen: 90_000, recipientChannel: "+60110000000", fault: "none" });
  if (!queued.ok) throw new Error(queued.reason);
  const handoffId = `registered:${queued.runId}`;
  await wb.assignDispatch(handoffId, "CR-1000");
  const submitted = await wb.submitCourierHandoff(handoffId, { signed: true, courierId: "CR-1000" });
  expect((await wb.resolveHandoff(submitted.item.eventId, { action: "approve" })).recipientConfirmation).not.toBeNull();
  expect(wb.courierWorkspace("CR-1000").items.find((row) => row.handoffId === handoffId)?.currentRun?.sealed).toBe(true);
});

it("does not issue confirmation for a rejected unsealed delivery", async () => {
  const submitted = await online("lifecycle-reject");
  const rejected = await wb.resolveHandoff(submitted.item.eventId, { action: "reject" });
  expect(rejected.recipientConfirmation).toBeNull();
  expect(wb.courierWorkspace("CR-1002").items.find((row) => row.eventId === submitted.item.eventId)?.state).toBe("resolved_rejected");
});

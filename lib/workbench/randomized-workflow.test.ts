import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createHarness } from "@/lib/generate";
import { createMigratedDb } from "@/lib/db/migrate";
import { canonicalHash } from "@/lib/ledger";
import { resolveRuntimeLlm } from "@/lib/llm/runtime";
import { createWorkbench, type OperatorWorkbench } from "./service";

vi.mock("@/lib/generate", async (load) => {
  const actual = await load<typeof import("@/lib/generate")>();
  return { ...actual, createHarness: vi.fn(actual.createHarness) };
});

let wb: OperatorWorkbench;
const store = createMigratedDb(":memory:");
beforeAll(async () => {
  wb = await createWorkbench({ scenarioIds: ["S0", "S1"], courierDrafts: true, runtimeLlm: resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "none" }) });
  wb.configureOnline({ store, boundary: {
    version: "random-workflow-test", source: "fixture", licence: "n/a",
    area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [
      [[101.6, 3.1], [101.76, 3.1], [101.76, 3.2], [101.6, 3.2], [101.6, 3.1]],
    ] } },
  } });
}, 120_000);
afterAll(() => wb?.close());

async function queued(seed: string, courierId = "CR-1002", target = wb) {
  const request = { origin: { latitude: 3.13, longitude: 101.67 },
    destination: { latitude: 3.165, longitude: 101.73 }, declaredValueSen: 90_000,
    recipientChannel: "+60110000000", simulation: { mode: "randomized" as const, seed, version: "signals-v1" as const } };
  const created = await target.createOnlineShipment(request, `random-workflow-${seed}`, { awaitAssignment: true });
  if (created.status !== "created") throw new Error(created.status);
  const handoffId = `online:${created.shipmentId}`;
  await target.assignDispatch(handoffId, courierId);
  const item = target.courierWorkspace(courierId).items.find((item) => item.handoffId === handoffId)!;
  return { created, handoffId, item, request };
}

it("persists sampled facts, preserves confirmed points and reuses signed delivery bytes", async () => {
  const { handoffId, item, created, request } = await queued("workflow-stable");
  expect(item.simulation?.seed).toBe("workflow-stable");
  expect(item.simulation?.history?.source).toBe("simulated");
  const stored = store.$client.prepare("SELECT simulation_snapshot_json FROM shipments WHERE shipment_id = ?").get(created.shipmentId) as {simulation_snapshot_json: string};
  expect(stored.simulation_snapshot_json).not.toContain("privateKey");
  expect(JSON.parse(stored.simulation_snapshot_json).timeline).toHaveLength(6);
  const first = await wb.submitCourierHandoff(handoffId, { signed: true, courierId: "CR-1002" });
  const before = wb.getHandoff(first.item.eventId)!;
  const hash = canonicalHash(before.event);
  expect(before.simulation?.seed).toBe("workflow-stable");
  expect(before.route?.destination.coordinate).toBe("3.165000, 101.730000");
  expect(before.checks.singleEvent.find((row) => row.id === "I1")?.status).toBe("not_evaluated");
  await wb.submitCourierHandoff(handoffId, { signed: true, courierId: "CR-1002", simulatedScan: { latitude: 3.11, longitude: 101.61 } });
  expect(canonicalHash(wb.getHandoff(first.item.eventId)!.event)).toBe(hash);
  expect((await wb.createOnlineShipment(request, "random-workflow-workflow-stable", { awaitAssignment: true })).status).toBe("replayed");
});

it("extends the same courier's history across random shipments without rewriting an older judgment", async () => {
  const first = await queued("history-first");
  const submitted = await wb.submitCourierHandoff(first.handoffId, { signed: true, courierId: "CR-1002" });
  const before = wb.getHandoff(submitted.item.eventId)!;
  const judgment = canonicalHash(before.authoritativeRun);
  const second = await queued("history-second");
  expect(second.item.simulation?.history?.runId).toBe(first.item.simulation?.history?.runId);
  expect(second.item.simulation!.history!.priorHandoffs).toBeGreaterThan(first.item.simulation!.history!.priorHandoffs);
  expect(canonicalHash(wb.getHandoff(submitted.item.eventId)!.authoritativeRun)).toBe(judgment);
  expect(Date.parse(second.item.eventTime)).toBeGreaterThan(Date.parse(first.item.eventTime));
  const other = await queued("other-courier", "CR-1003");
  expect(other.item.simulation?.history?.runId).not.toBe(second.item.simulation?.history?.runId);
});

it("serializes concurrent same-courier assignment snapshots", async () => {
  const [a, b] = await Promise.all([queued("parallel-a", "CR-1000"), queued("parallel-b", "CR-1000")]);
  expect(a.item.simulation?.history?.runId).toBeDefined();
  expect(a.item.simulation?.history?.runId).toBe(b.item.simulation?.history?.runId);
  expect(a.item.simulation?.history?.priorHandoffs).not.toBe(b.item.simulation?.history?.priorHandoffs);
  expect(a.item.eventTime).not.toBe(b.item.eventTime);
});

it("replays the same historical disputes used for the stored pattern result", async () => {
  const scenario = wb.listHandoffs().items.find((item) => item.scenarioId.startsWith("B-O-") && item.legIndex === 0 && wb.getHandoff(item.eventId)?.simulation?.seed === "workflow-stable")!;
  const original = wb.getHandoff(scenario.eventId)!;
  const replay = await wb.replayHandoff(scenario.scenarioId, 0);
  expect(replay.pattern?.score).toBe(original.summary.pattern.score);
  expect(replay.patternOutcome?.flags.map((flag) => flag.id)).toEqual(original.flags.filter((flag) => flag.id.startsWith("P")).map((flag) => flag.id));
});

it("freezes a failed preparation's bootstrap before later assignments and retries it without publishing a phantom run", async () => {
  const request = { origin: { latitude: 3.13, longitude: 101.67 }, destination: { latitude: 3.165, longitude: 101.73 },
    declaredValueSen: 90_000, recipientChannel: "+60110000000",
    simulation: { mode: "randomized" as const, seed: "failed-preparation", version: "signals-v1" as const } };
  const created = await wb.createOnlineShipment(request, "failed-preparation", { awaitAssignment: true });
  if (created.status !== "created") throw new Error(created.status);
  const handoffId = `online:${created.shipmentId}`;
  vi.mocked(createHarness).mockImplementationOnce(() => { throw new Error("injected temporary harness failure"); });
  await expect(wb.assignDispatch(handoffId, "CR-1001")).rejects.toThrow(/injected/);
  expect(wb.courierWorkspace("CR-1001").items.some((item) => item.handoffId === handoffId)).toBe(false);
  await queued("after-failure", "CR-1001");
  await expect(wb.assignDispatch(handoffId, "CR-1001")).resolves.toBeDefined();
  expect(wb.courierWorkspace("CR-1001").items.some((item) => item.handoffId === handoffId)).toBe(true);
});

it("carries a recipient's later complaint into future snapshots without rewriting the earlier judgment", async () => {
  const fresh = await createWorkbench({ scenarioIds: ["S0"], runtimeLlm: resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "none" }) });
  fresh.configureOnline({ store: createMigratedDb(":memory:"), boundary: {
    version: "complaint-fixture", source: "fixture", licence: "n/a", area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [
      [[101.6, 3.1], [101.76, 3.1], [101.76, 3.2], [101.6, 3.2], [101.6, 3.1]],
    ] } },
  } });
  try {
    const first = await queued("signals-v1-validation-004", "CR-1000", fresh);
    const submitted = await fresh.submitCourierHandoff(first.handoffId, { signed: true, courierId: "CR-1000" });
    let before = fresh.getHandoff(submitted.item.eventId)!;
    if (before.canApprove) before = await fresh.resolveHandoff(submitted.item.eventId, { action: "approve" });
    expect(before.recipientConfirmation).not.toBeNull();
    const judgment = canonicalHash(before.authoritativeRun);
    expect(fresh.answerConfirmation(before.recipientConfirmation!.tokenId, "not_received").ok).toBe(true);
    const next = await queued("after-recipient-complaint", "CR-1000", fresh);
    const priorLeg = fresh.listHandoffs().items.find((item) => item.scenarioId === next.item.runId)!;
    const copied = fresh.debugHandle(priorLeg.eventId).db;
    expect(copied.$client.prepare("SELECT count(*) n FROM disputes WHERE event_id = ?").get(submitted.item.eventId)).toEqual({ n: 1 });
    expect(canonicalHash(fresh.getHandoff(submitted.item.eventId)!.authoritativeRun)).toBe(judgment);
  } finally { fresh.close(); }
});

it("co-signs an older pending delivery against its saved history after a newer shipment is prepared", async () => {
  const fresh = await createWorkbench({ scenarioIds: ["S0"], runtimeLlm: resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "none" }) });
  fresh.configureOnline({ store: createMigratedDb(":memory:"), boundary: {
    version: "cosign-snapshot-fixture", source: "fixture", licence: "n/a", area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [
      [[101.6, 3.1], [101.76, 3.1], [101.76, 3.2], [101.6, 3.2], [101.6, 3.1]],
    ] } },
  } });
  try {
    const first = await queued("signals-v1-validation-004", "CR-1000", fresh);
    const submitted = await fresh.submitCourierHandoff(first.handoffId, { signed: true, courierId: "CR-1000" });
    const pending = fresh.getHandoff(submitted.item.eventId)!;
    expect(pending.canApprove).toBe(true);
    const evidence = { event: canonicalHash(pending.event), checks: pending.checks, flags: pending.flags,
      single: pending.summary.inconsistency, pattern: pending.summary.pattern };
    await queued("newer-before-cosign", "CR-1000", fresh);
    const sealed = await fresh.resolveHandoff(submitted.item.eventId, { action: "approve" });
    expect(sealed.summary.sealed).toBe(true);
    expect({ event: canonicalHash(sealed.event), checks: sealed.checks, flags: sealed.flags,
      single: sealed.summary.inconsistency, pattern: sealed.summary.pattern }).toEqual(evidence);
    expect(sealed.credential?.operatorValid).toBe(true);
  } finally { fresh.close(); }
});

import { afterAll, beforeAll, expect, it } from "vitest";
import { createMigratedDb } from "@/lib/db/migrate";
import type { VigilDb } from "@/lib/db/client";
import { locationSnapshots, shipments } from "@/lib/db/schema";
import { simulationOf } from "@/lib/simulation/config";
import { createWorkbench, type OperatorWorkbench } from "@/lib/workbench";
import { resolveRuntimeLlm } from "@/lib/llm/runtime";
import { GET, POST } from "./route";

let workbench: OperatorWorkbench;
let store: VigilDb;
beforeAll(async () => {
  workbench = await createWorkbench({ scenarioIds: ["S0"], runtimeLlm: resolveRuntimeLlm({}) });
  store = createMigratedDb(":memory:");
  workbench.configureOnline({ store, boundary: { version: "test", source: "fixture", licence: "n/a", area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[101.6, 3.1], [101.8, 3.1], [101.8, 3.2], [101.6, 3.2], [101.6, 3.1]]] } } } });
  globalThis.__vigilOperatorWorkbench = Promise.resolve(workbench);
}, 120_000);
afterAll(() => { globalThis.__vigilOperatorWorkbench = undefined; workbench?.close(); });

it("lists pending online shipments from the route-owned workbench, excluding registered and delivered work", async () => {
  const first = await workbench.createOnlineShipment({ origin: { latitude: 3.13, longitude: 101.67 }, destination: { latitude: 3.16, longitude: 101.73 }, declaredValueSen: 12_000, recipientChannel: "+60119990007" }, "route-pending", { awaitAssignment: true });
  if (first.status !== "created") throw new Error(first.status);
  workbench.queueRegisteredShipment({ originIndex: 0, destinationIndex: 20, declaredValueSen: 12_000, recipientChannel: "+60119990001", fault: "none" });
  const delivered = await workbench.createOnlineShipment({ origin: { latitude: 3.13, longitude: 101.67 }, destination: { latitude: 3.17, longitude: 101.74 }, declaredValueSen: 12_000, recipientChannel: "+60119990007" }, "route-delivered");
  if (delivered.status !== "created") throw new Error(delivered.status);
  await workbench.deliverOnlineShipment(delivered.shipmentId);
  const response = await GET();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({ kind: "online", shipmentId: first.shipmentId, delivered: false, assignmentState: "awaiting_assignment" });
});

const REQUEST = {
  origin: { latitude: 3.13, longitude: 101.67 },
  destination: { latitude: 3.16, longitude: 101.73 },
  declaredValueSen: 12_000,
  recipientChannel: "+60119990007",
};
function post(body: unknown, key: string) {
  return POST(new Request("http://localhost/api/sender/online-shipments", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  }));
}

it.each(["normal", "mock_location"] as const)("accepts randomized config independently of %s and fills the request version", async (demoCondition) => {
  const simulation = { mode: "randomized", seed: `api-${demoCondition}` };
  const key = `api-random-${demoCondition}`;
  const response = await post({ ...REQUEST, simulation, demoCondition }, key);
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.awaitingAssignment).toBe(true);
  const row = store.select().from(shipments).all().find((row) => row.shipmentId === body.shipmentId)!;
  expect(simulationOf(row)).toEqual({ ...simulation, version: "signals-v1" });
  expect(row.demoCondition).toBe(demoCondition);
  expect(row.simulationSnapshotJson).toBeNull();

  const count = store.select().from(locationSnapshots).all().length;
  const replay = await post({ ...REQUEST, simulation: { version: "signals-v1", ...simulation }, demoCondition }, key);
  expect(replay.status).toBe(200);
  expect((await replay.json()).shipmentId).toBe(body.shipmentId);
  const conflict = await post({ ...REQUEST, simulation: { ...simulation, seed: "different" }, demoCondition }, key);
  expect(conflict.status).toBe(409);
  expect(store.select().from(locationSnapshots).all()).toHaveLength(count);
});

it.each([
  null, {},
  { mode: "randomized", seed: "" },
  { mode: "randomized", seed: "a".repeat(81) },
  { mode: "randomized", seed: "two words" },
  { mode: "randomized", seed: "valid", version: "signals-v2" },
  { mode: "normal", seed: "valid" },
  { mode: "randomized", seed: "valid", thresholds: {} },
  { mode: "randomized", seed: "valid", scores: [80] },
  { mode: "randomized", seed: "valid", decision: "accept" },
])("refuses invalid simulation config before writing: %j", async (simulation) => {
  const before = store.select().from(shipments).all().length;
  const response = await post({ ...REQUEST, simulation }, "api-invalid-config");
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.issues.some((issue: { path: string[] }) => issue.path[0] === "simulation")).toBe(true);
  expect(store.select().from(shipments).all()).toHaveLength(before);
});

it("keeps the outer API strict with simulation present", async () => {
  const before = store.select().from(shipments).all().length;
  const response = await post({ ...REQUEST, simulation: { mode: "randomized", seed: "valid" }, decision: "accept" }, "api-extra-field");
  expect(response.status).toBe(400);
  expect(store.select().from(shipments).all()).toHaveLength(before);
});

it("preserves omitted simulation and legacy normal/mock requests", async () => {
  for (const demoCondition of [undefined, "normal", "mock_location"]) {
    const response = await post({ ...REQUEST, demoCondition }, `api-legacy-${demoCondition}`);
    expect(response.status).toBe(201);
    const body = await response.json();
    const row = store.select().from(shipments).all().find((row) => row.shipmentId === body.shipmentId)!;
    expect(row.simulationJson).toBeNull();
    expect(row.simulationSnapshotJson).toBeNull();
    expect(row.demoCondition).toBe(demoCondition ?? "normal");
  }
});

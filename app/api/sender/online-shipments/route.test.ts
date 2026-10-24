import { afterAll, beforeAll, expect, it } from "vitest";
import { createMigratedDb } from "@/lib/db/migrate";
import { createWorkbench, type OperatorWorkbench } from "@/lib/workbench";
import { resolveRuntimeLlm } from "@/lib/llm/runtime";
import { GET } from "./route";

let workbench: OperatorWorkbench;
beforeAll(async () => {
  workbench = await createWorkbench({ scenarioIds: ["S0"], runtimeLlm: resolveRuntimeLlm({}) });
  workbench.configureOnline({ store: createMigratedDb(":memory:"), boundary: { version: "test", source: "fixture", licence: "n/a", area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[101.6, 3.1], [101.8, 3.1], [101.8, 3.2], [101.6, 3.2], [101.6, 3.1]]] } } } });
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

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/db/client";
import { createMigratedDb } from "@/lib/db/migrate";
import { createWorkbench, type OperatorWorkbench } from "@/lib/workbench";
import { resolveRuntimeLlm } from "@/lib/llm/runtime";
import { POST as correctRegistered } from "./sender/shipments/[runId]/correct/route";
import { POST as correctOnline } from "./sender/online-shipments/[shipmentId]/correct/route";
import { POST as submitCourier } from "./courier/handoffs/[handoffId]/submit/route";

let workbench: OperatorWorkbench;
const store = createMigratedDb(":memory:");
beforeAll(async () => {
  workbench = await createWorkbench({ scenarioIds: ["S0"], runtimeLlm: resolveRuntimeLlm({}) });
  workbench.configureOnline({ store, boundary: { version: "test", source: "test fixture", licence: "n/a", area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[101.6, 3.1], [101.8, 3.1], [101.8, 3.2], [101.6, 3.2], [101.6, 3.1]]] } } } });
  globalThis.__vigilOperatorWorkbench = Promise.resolve(workbench);
}, 30_000);
afterAll(() => { globalThis.__vigilOperatorWorkbench = undefined; workbench.close(); closeDb(store); });
const request = (body: unknown) => new Request("http://localhost/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("mutation responses are complete enough to render directly", () => {
  it("returns the corrected registered shipment without changing the original reference", async () => {
    const created = await workbench.runBuilt({ originIndex: 0, destinationIndex: 20, declaredValueSen: 12_000, recipientChannel: "+60119990001", fault: "none" }, { holdDelivery: true });
    if (!created.ok) throw new Error(created.reason);
    const response = await correctRegistered(request({ addressIndex: 15 }), { params: Promise.resolve({ runId: created.runId }) });
    const body = await response.json();
    expect(body.shipment.recordedAddress).toBe("Shah Alam Seksyen 13, Selangor");
    expect(body.shipment.correction.toLabel).toBe("Petaling Jaya, Selangor");
  });

  it("returns the saved online correction and the courier submission workspace", async () => {
    const created = await workbench.createOnlineShipment({ origin: { latitude: 3.13, longitude: 101.67 }, destination: { latitude: 3.165, longitude: 101.73, addressClaim: "Original reference" }, declaredValueSen: 12_000, recipientChannel: "+60119990007" }, "mutation-online");
    if (created.status !== "created") throw new Error(created.status);
    const response = await correctOnline(request({ latitude: 3.15, longitude: 101.7, addressClaim: "Confirmed correction" }), { params: Promise.resolve({ shipmentId: created.shipmentId }) });
    const body = await response.json();
    expect(body.shipment.recordedAddress).toBe("Original reference");
    expect(body.shipment.correction).toMatchObject({ toLabel: "Confirmed correction", toPoint: { latitude: 3.15, longitude: 101.7 } });
    const handoffId = `online:${created.shipmentId}`;
    const submitted = await submitCourier(request({ signed: true }), { params: Promise.resolve({ handoffId }) });
    const result = await submitted.json();
    expect(result.workspace.identity).toMatchObject({ role: "courier", subject: result.item.courierId });
    expect(result.workspace.items.find((item: { handoffId: string }) => item.handoffId === handoffId).attempts).toHaveLength(1);
  });
});

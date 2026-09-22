import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/db/client";
import { createMigratedDb } from "@/lib/db/migrate";
import type { ServiceBoundary } from "@/lib/shipment";
import { createWorkbench, type OperatorWorkbench } from "@/lib/workbench";
import { GET } from "./route";

const boundary: ServiceBoundary = {
  version: "stream-test-v1",
  source: "test fixture",
  licence: "n/a",
  area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[101.6, 3.1], [101.76, 3.1], [101.76, 3.2], [101.6, 3.2], [101.6, 3.1]]] } },
};
const store = createMigratedDb(":memory:");
let workbench: OperatorWorkbench;

beforeAll(async () => {
  workbench = await createWorkbench({ scenarioIds: ["S0"] });
  workbench.configureOnline({ store, boundary });
  globalThis.__vigilOperatorWorkbench = Promise.resolve(workbench);
}, 120_000);
afterAll(() => { workbench.close(); closeDb(store); globalThis.__vigilOperatorWorkbench = undefined; });

describe("the live replay route", () => {
  it("returns one visible terminal failure frame instead of a retrying 400", async () => {
    const response = await GET(new Request("http://localhost/api/stream?scenario=missing&leg=5"));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body.match(/event: failure/g)).toHaveLength(1);
    expect(body).toMatch(/No stored shipment/);
  });

  it("replays a built shipment through the same agent", async () => {
    const built = await workbench.runBuilt({ originIndex: 0, destinationIndex: 20, declaredValueSen: 12_000, recipientChannel: "+60111234567", fault: "none" });
    if (!built.ok) throw new Error(built.reason);
    const response = await GET(new Request(`http://localhost/api/stream?scenario=${built.runId}&leg=5`));
    const body = await response.text();
    expect(body).toContain("event: result");
    expect(body).not.toContain("event: failure");
  }, 60_000);

  it("replays an online shipment from its stored location snapshots", async () => {
    const created = await workbench.createOnlineShipment({
      origin: { latitude: 3.13, longitude: 101.67, addressClaim: "Origin" },
      destination: { latitude: 3.165, longitude: 101.73, addressClaim: "Destination" },
      declaredValueSen: 12_000,
      recipientChannel: "+60111234567",
    }, "stream-online");
    if (created.status !== "created") throw new Error(created.status);
    const delivered = await workbench.deliverOnlineShipment(created.shipmentId);
    if (!delivered.ok) throw new Error(delivered.reason);
    const response = await GET(new Request(`http://localhost/api/stream?scenario=B-O-${created.shipmentId}&leg=5`));
    const body = await response.text();
    expect(body).toContain("event: result");
    expect(body).not.toContain("event: failure");
  }, 60_000);
});

import { beforeEach, expect, it, vi } from "vitest";

const listSenderShipments = vi.fn();
vi.mock("@/lib/workbench", () => ({
  getWorkbench: async () => ({ listSenderShipments }),
}));

beforeEach(() => listSenderShipments.mockReset());

it("lists only pending online shipments from the same route-owned workbench", async () => {
  const online = { kind: "online", runId: "B-O-one", delivered: false };
  listSenderShipments.mockReturnValue([
    online,
    { kind: "registered", runId: "B-one", delivered: false },
    { kind: "online", runId: "B-O-done", delivered: true },
  ]);

  const route = await import("./route");
  expect(typeof route.GET).toBe("function");
  const response = await route.GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ items: [online] });
});

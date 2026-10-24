// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { OnlineShipmentPanel } from "./online-shipment-panel";
import { SenderShipments } from "./sender-shipments";
import type { SenderShipmentView } from "@/lib/workbench/service";
import type { ServiceAreaView } from "./online-shipment-model";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("./service-area-map", () => ({ ServiceAreaMap: ({ onPick }: { onPick: (lat: number, lng: number) => void }) => createElement("div", null,
  createElement("button", { onClick: () => onPick(3.15, 101.7) }, "Pick origin"),
  createElement("button", { onClick: () => onPick(3.16, 101.71) }, "Pick destination"),
) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const policy = { cosignOverSen: 40000, codCapSen: 20000, maxValueSen: 100000, courier: "Assigned courier" };
const area: ServiceAreaView = {
  version: "test", source: "test", licence: "test", placeholder: false,
  members: ["Kuala Lumpur"], sentence: "Service area: Kuala Lumpur", outsideMessage: "Outside service area",
  label: "Kuala Lumpur", credit: "test", extracted: null, showExtracted: false,
  area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[101.6, 3.1], [101.8, 3.1], [101.8, 3.2], [101.6, 3.2], [101.6, 3.1]]] } },
};
const queued: SenderShipmentView = {
  kind: "online", shipmentId: "online-pending", runId: "pending-online", waybillNo: "WB-ONLINE-PENDING",
  originLabel: "Pickup label", recordedAddress: "Actual geocoder destination", declaredValueSen: 18000,
  delivered: false, deliveryEventId: null, assignmentState: "awaiting_assignment", assignedCourier: null,
  recordedPoint: { latitude: 3.16, longitude: 101.71 },
};

it.each(["created", "replayed"])("shows a %s pending receipt and adopts its items before the reference GET finishes", async (status) => {
  let resolveReference!: (value: unknown) => void;
  const fetcher = vi.fn((url: string, options?: RequestInit) => {
    if (url === "/api/sender/online-shipments/online-pending") return new Promise((done) => { resolveReference = done; });
    const body = url.endsWith("service-area") ? area
      : url.endsWith("/reverse") ? { status: "found", label: "Actual geocoder destination", ref: "node/1" }
      : options?.method === "POST" ? { status, shipmentId: queued.shipmentId, running: false, awaitingAssignment: true, eventIds: [], boundary: { label: area.label }, items: [queued] }
      : { items: [] };
    return Promise.resolve({ ok: true, json: async () => body });
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(createElement("div", null,
    createElement(OnlineShipmentPanel, { policy }),
    createElement(SenderShipments, { shipments: [], addresses: [] }),
  ));
  fireEvent.click(await view.findByRole("button", { name: "Pick origin" }));
  fireEvent.click(view.getByRole("button", { name: "Confirm as collection point" }));
  fireEvent.click(view.getByRole("button", { name: "Pick destination" }));
  fireEvent.click(view.getByRole("button", { name: "Confirm as delivery point" }));
  fireEvent.click(view.getByRole("button", { name: "Create shipment at these points" }));

  await view.findByText("WB-ONLINE-PENDING");
  expect(view.getByRole("status").textContent).toMatch(/awaiting operator assignment/i);
  expect(view.queryByText(/legs ran|out-for-delivery|run is not restartable/i)).toBeNull();
  expect(view.queryByRole("button", { name: "Courier delivers" })).toBeNull();
  expect(view.getByText("Actual geocoder destination", { selector: "dd" })).toBeTruthy();
  if (status === "replayed") expect(view.getByRole("status").textContent).toMatch(/already on file/i);
  await waitFor(() => expect(resolveReference).toBeTypeOf("function"));
  resolveReference({ ok: true, json: async () => ({ history: { originalReference: { latitude: 3.160123, longitude: 101.710456 } } }) });
  await view.findByText("3.160123, 101.710456");
  const request = fetcher.mock.calls.find(([url, options]) => url === "/api/sender/online-shipments" && options?.method === "POST");
  expect(JSON.parse(request![1]!.body as string).destination).toMatchObject({ latitude: 3.16, longitude: 101.71 });
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/sender/shipments")).toHaveLength(1);
});

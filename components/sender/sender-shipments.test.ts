// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { SenderShipments } from "./sender-shipments";
import type { SenderShipmentView } from "@/lib/workbench/service";
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const addresses = [{ index: 0, label: "Original" }, { index: 1, label: "Corrected" }];
const shipment: SenderShipmentView = { runId: "run-1", waybillNo: "WB-1", originLabel: "Pickup", recordedAddress: "Original", declaredValueSen: 12000, delivered: false, deliveryEventId: null };
it("has a real empty pending section for the sidebar anchor", () => {
  const view = render(createElement(SenderShipments, { shipments: [], addresses }));
  expect(view.getByText("No pending delivery scans.")).toBeTruthy();
  expect(view.container.querySelector("#pending-deliveries")).toBeTruthy();
});
it("corrects only the registered index, preserving the displayed original reference", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetcher);
  const view = render(createElement(SenderShipments, { shipments: [shipment], addresses }));
  fireEvent.click(view.getByRole("button", { name: "Correct" }));
  await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
  const correction = fetcher.mock.calls.find(([url]) => url === "/api/sender/shipments/run-1/correct");
  expect(correction).toBeTruthy();
  expect(JSON.parse(correction![1].body)).toEqual({ addressIndex: 1 });
  expect(view.getByText("Original")).toBeTruthy();
});
it("labels proxy delivery as demo behavior and redirects by returned eventId, not a fabricated verdict", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, eventId: "pending-event" }) }));
  const view = render(createElement(SenderShipments, { shipments: [shipment], addresses }));
  expect(view.getByText(/Demo control/)).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Courier delivers" }));
  await waitFor(() => expect(router.push).toHaveBeenCalledWith("/operator/handoffs/pending-event"));
});

it("uses the confirmed-point correction route for an online shipment instead of the cached-address dropdown", () => {
  const online = {
    ...shipment,
    kind: "online" as const,
    shipmentId: "shipment-online-1",
    recordedPoint: { latitude: 3.165, longitude: 101.73 },
  };
  const view = render(createElement(SenderShipments, { shipments: [online], addresses }));

  expect(view.queryByLabelText("Correct address for WB-1")).toBeNull();
  expect(view.getByRole("button", { name: /choose a corrected point/i })).toBeTruthy();
  expect(view.getByRole("button", { name: "Courier delivers" })).toBeTruthy();
});

it("loads online pending shipments from the route bundle and refreshes when one is created", async () => {
  const online = {
    ...shipment,
    kind: "online" as const,
    shipmentId: "shipment-online-1",
    runId: "B-O-online-1",
    waybillNo: "WB-ONLINE-1",
    recordedPoint: { latitude: 3.165, longitude: 101.73 },
  };
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [online] }) });
  vi.stubGlobal("fetch", fetcher);

  const view = render(createElement(SenderShipments, { shipments: [], addresses }));
  await waitFor(() => expect(view.getByText("WB-ONLINE-1")).toBeTruthy());

  window.dispatchEvent(new Event("vigil:sender-shipments-changed"));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});

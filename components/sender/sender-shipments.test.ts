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
  expect(fetcher.mock.calls[0][0]).toBe("/api/sender/shipments/run-1/correct");
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ addressIndex: 1 });
  expect(view.getByText("Original")).toBeTruthy();
});
it("labels proxy delivery as demo behavior and redirects by returned eventId, not a fabricated verdict", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, eventId: "pending-event" }) }));
  const view = render(createElement(SenderShipments, { shipments: [shipment], addresses }));
  expect(view.getByText(/Demo control/)).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Courier delivers" }));
  await waitFor(() => expect(router.push).toHaveBeenCalledWith("/operator/handoffs/pending-event"));
});

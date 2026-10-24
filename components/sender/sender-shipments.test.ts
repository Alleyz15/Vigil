// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { SenderShipments } from "./sender-shipments";
import type { SenderShipmentView } from "@/lib/workbench/service";
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./service-area-map", () => ({ ServiceAreaMap: ({ onPick }: { onPick: (lat: number, lng: number) => void }) => createElement("button", { onClick: () => onPick(3.15, 101.7) }, "Select correction coordinate") }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const addresses = [{ index: 0, label: "Original" }, { index: 1, label: "Corrected" }];
const shipment: SenderShipmentView = { runId: "run-1", waybillNo: "WB-1", originLabel: "Pickup", recordedAddress: "Original", declaredValueSen: 12000, delivered: false, deliveryEventId: null };
it("has a real empty pending section for the sidebar anchor", () => {
  const view = render(createElement(SenderShipments, { shipments: [], addresses }));
  expect(view.getByText("No pending shipments.")).toBeTruthy();
  expect(view.container.querySelector("#pending-deliveries")).toBeTruthy();
});
it("corrects only the registered index, preserving the displayed original reference", async () => {
  const corrected = { ...shipment, correction: { fromLabel: "Original", toLabel: "Corrected", toIndex: 1, toPoint: { latitude: 3.1, longitude: 101.7 }, correctedAt: "2026-09-08T10:00:00Z" } };
  const fetcher = vi.fn().mockImplementation(async (url) => ({ ok: true, json: async () => url.endsWith("/correct") ? { ok: true, shipment: corrected } : { items: [shipment] } }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(createElement(SenderShipments, { shipments: [shipment], addresses }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/sender/shipments", expect.anything()));
  await waitFor(() => expect(view.getByRole("button", { name: "Refresh" }).getAttribute("aria-busy")).toBe("false"));
  fireEvent.click(view.getByRole("button", { name: "Correct" }));
  await waitFor(() => expect(view.getByText("Corrected to")).toBeTruthy());
  expect(view.queryByRole("button", { name: "Correct" })).toBeNull();
  expect(router.refresh).not.toHaveBeenCalled();
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

it("loads all pending shipments and adopts a creation snapshot without another GET", async () => {
  const online = {
    ...shipment,
    kind: "online" as const,
    shipmentId: "shipment-online-1",
    runId: "B-O-online-1",
    waybillNo: "WB-ONLINE-1",
    recordedPoint: { latitude: 3.165, longitude: 101.73 },
  };
  const registered = { ...shipment, runId: "pending-registered", waybillNo: "WB-REGISTERED", assignmentState: "awaiting_assignment" as const, assignedCourier: null };
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [registered, online] }) });
  vi.stubGlobal("fetch", fetcher);

  const view = render(createElement(SenderShipments, { shipments: [], addresses }));
  await waitFor(() => expect(view.getByText("WB-ONLINE-1")).toBeTruthy());
  expect(view.getByText("WB-REGISTERED")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledWith("/api/sender/shipments", expect.objectContaining({ cache: "no-store" }));

  act(() => window.dispatchEvent(new CustomEvent("vigil:sender-shipments-changed", { detail: { items: [registered] } })));
  expect(view.queryByText("WB-ONLINE-1")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("renders a confirmed-point correction from the POST response without refreshing", async () => {
  const online = { ...shipment, kind: "online" as const, shipmentId: "online-1", runId: "B-O-online-1" };
  const corrected = { ...online, correction: { fromLabel: "Original", toLabel: "New confirmed point", toPoint: { latitude: 3.15, longitude: 101.7 }, correctedAt: "2026-09-08T10:00:00Z" } };
  const area = { area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[101.6, 3.1], [101.8, 3.1], [101.8, 3.2], [101.6, 3.2], [101.6, 3.1]]] } } };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("service-area") ? area : url.endsWith("/correct") ? { ok: true, shipment: corrected } : { items: [online] } })));
  const view = render(createElement(SenderShipments, { shipments: [online], addresses }));
  fireEvent.click(view.getByRole("button", { name: /choose a corrected point/i }));
  fireEvent.click(await view.findByRole("button", { name: "Select correction coordinate" }));
  fireEvent.click(view.getByRole("button", { name: "Confirm as corrected delivery point" }));
  await view.findByText("New confirmed point");
  expect(view.getByText("Original")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Confirm as corrected delivery point" })).toBeNull();
  expect(router.refresh).not.toHaveBeenCalled();
});

const awaiting: SenderShipmentView = { ...shipment, assignmentState: "awaiting_assignment", assignedCourier: null };

it.each(["registered", "online"] as const)("withholds %s correction and delivery before assignment", (kind) => {
  const view = render(createElement(SenderShipments, { shipments: [{ ...awaiting, kind, shipmentId: kind === "online" ? "online-pending" : undefined, recordedAddress: "Actual geocoder label" }], addresses }));
  expect(view.getByText(/awaiting operator assignment/i)).toBeTruthy();
  expect(view.getByText("Actual geocoder label")).toBeTruthy();
  expect(view.getByRole("link", { name: /operator assignment/i }).getAttribute("href")).toBe("/operator/handoffs");
  expect(view.queryByRole("button", { name: "Courier delivers" })).toBeNull();
  expect(view.queryByRole("button", { name: "Correct" })).toBeNull();
  expect(view.queryByRole("button", { name: /choose a corrected point/i })).toBeNull();
  expect(view.queryByText(/courier (will be|was) told/i)).toBeNull();
  expect(view.queryByText(/run run-1/)).toBeNull();
});

it("refreshes assignment and exposes the existing correction and delivery actions", async () => {
  const assigned: SenderShipmentView = { ...shipment, assignmentState: "assigned", assignedCourier: "CR-1002" };
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ items: [awaiting] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [assigned] }) });
  vi.stubGlobal("fetch", fetcher);
  const view = render(createElement(SenderShipments, { shipments: [awaiting], addresses }));
  const refresh = view.getByRole("button", { name: "Refresh" });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(refresh);
  await view.findByText("CR-1002");
  expect(view.queryByText(/awaiting operator assignment/i)).toBeNull();
  expect(view.getByRole("button", { name: "Correct" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Courier delivers" })).toBeTruthy();
  expect(router.refresh).not.toHaveBeenCalled();
});

it.each(["http", "network", "malformed"])("shows %s refresh failures and retains the last known rows", async (failure) => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ items: [awaiting] }) });
  if (failure === "network") fetcher.mockRejectedValueOnce(new Error("offline"));
  else fetcher.mockResolvedValueOnce({ ok: failure !== "http", json: async () => ({ error: "unavailable" }) });
  vi.stubGlobal("fetch", fetcher);
  const view = render(createElement(SenderShipments, { shipments: [awaiting], addresses }));
  const refresh = view.getByRole("button", { name: "Refresh" });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(refresh);
  expect((await view.findByRole("alert")).textContent).toMatch(/could not.*load|could not.*refresh/i);
  expect(view.getByText("WB-1")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Courier delivers" })).toBeNull();
});

it("does not let an old list request overwrite a direct mutation snapshot", async () => {
  let resolve!: (value: unknown) => void;
  const fetcher = vi.fn(() => new Promise((done) => { resolve = done; }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(createElement(SenderShipments, { shipments: [], addresses }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  act(() => window.dispatchEvent(new CustomEvent("vigil:sender-shipments-changed", { detail: { items: [awaiting] } })));
  await view.findByText("WB-1");
  await act(async () => resolve({ ok: true, json: async () => ({ items: [] }) }));
  expect(view.getByText("WB-1")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not let a list response erase a newer correction", async () => {
  let resolve!: (value: unknown) => void;
  const corrected = { ...shipment, correction: { fromLabel: "Original", toLabel: "Corrected", toIndex: 1, toPoint: { latitude: 3.1, longitude: 101.7 }, correctedAt: "2026-10-24T10:00:00Z" } };
  vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/correct")
    ? Promise.resolve({ ok: true, json: async () => ({ ok: true, shipment: corrected }) })
    : new Promise((done) => { resolve = done; })));
  const view = render(createElement(SenderShipments, { shipments: [shipment], addresses }));
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  fireEvent.click(view.getByRole("button", { name: "Correct" }));
  await view.findByText("Corrected to");
  await act(async () => resolve({ ok: true, json: async () => ({ items: [shipment] }) }));
  expect(view.getByText("Corrected to")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Correct" })).toBeNull();
});

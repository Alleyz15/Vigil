// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DispatchWorkspace } from "@/lib/workbench/operations-types";
import { DispatchWorkspaceView } from "./dispatch-workspace";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const workspace: DispatchWorkspace = {
  couriers: [{ role: "courier", subject: "CR-2", label: "Demo courier Mei", keyFingerprint: "ed25519-demo" }],
  items: [{ dispatchId: "dispatch-1", source: "online", waybillNo: "WB-DEMO-1", originLabel: "Sender reference A",
    destinationLabel: "Delivery reference B", originDepot: "Depot A", destinationDepot: "Depot B", declaredValueSen: 12345,
    state: "awaiting_assignment", courierId: null, createdAt: "2026-10-24T02:00:00Z", available: true }],
};
const response = (data: unknown, ok = true) => ({ ok, json: async () => data });

it("loads pending dispatches separately and uses the assignment response as assigned history", async () => {
  const assigned = { ...workspace, items: [{ ...workspace.items[0], state: "assigned", courierId: "CR-2" }] };
  const fetchMock = vi.fn().mockResolvedValueOnce(response(workspace)).mockResolvedValueOnce(response(assigned));
  vi.stubGlobal("fetch", fetchMock);
  const view = render(createElement(DispatchWorkspaceView));
  expect(view.getByRole("heading", { name: "Awaiting courier assignment" })).toBeTruthy();
  await view.findByText("WB-DEMO-1");
  expect(view.getByText("Sender reference A")).toBeTruthy();
  expect(view.getByText("Delivery reference B")).toBeTruthy();
  expect(view.getByText(/Simulated depots/)).toBeTruthy();
  expect(view.getByText(/123.45/)).toBeTruthy();
  expect((view.getByRole("button", { name: "Assign courier" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(view.getByRole("combobox", { name: "Courier for WB-DEMO-1" }), { target: { value: "CR-2" } });
  fireEvent.click(view.getByRole("button", { name: "Assign courier" }));
  await waitFor(() => expect(view.queryByRole("button", { name: "Assign courier" })).toBeNull());
  const history = view.getByRole("group", { name: "Assigned dispatch history" });
  expect((history as HTMLDetailsElement).open).toBe(false);
  fireEvent.click(within(history).getByText("Assigned dispatch history (1)"));
  expect((history as HTMLDetailsElement).open).toBe(true);
  expect(within(history).getByRole("table")).toBeTruthy();
  expect(within(history).getByText("WB-DEMO-1")).toBeTruthy();
  expect(within(history).getByText(/Demo courier Mei/)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenLastCalledWith("/api/operator/dispatches/dispatch-1/assign", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ courierId: "CR-2" }),
  });
});

it("retains the selected courier on failure, locks in flight, and refreshes only explicitly", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  const fetchMock = vi.fn().mockResolvedValueOnce(response(workspace)).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(response({ ...workspace, items: [] }));
  vi.stubGlobal("fetch", fetchMock);
  const view = render(createElement(DispatchWorkspaceView));
  await view.findByText("WB-DEMO-1");
  fireEvent.change(view.getByRole("combobox"), { target: { value: "CR-2" } });
  fireEvent.click(view.getByRole("button", { name: "Assign courier" }));
  expect((view.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
  expect((view.getByRole("button", { name: "Refresh dispatches" }) as HTMLButtonElement).disabled).toBe(true);
  finish(response({ error: "Courier assignment unavailable" }, false));
  await view.findByRole("alert");
  expect((view.getByRole("combobox") as HTMLSelectElement).value).toBe("CR-2");
  expect(view.getByText("WB-DEMO-1")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Refresh dispatches" }));
  await view.findByText("No shipments awaiting assignment.");
});

it("makes unavailable work read-only without implying live courier availability", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...workspace, items: [{ ...workspace.items[0], available: false }] })));
  const view = render(createElement(DispatchWorkspaceView));
  await view.findByText("WB-DEMO-1");
  expect(view.queryByRole("button", { name: "Assign courier" })).toBeNull();
  expect(view.getByText(/workflow unavailable/i)).toBeTruthy();
  expect(view.getByText(/Synthetic shipments/)).toBeTruthy();
});

it("offers explicit retry after the initial fetch fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(response(workspace)));
  const view = render(createElement(DispatchWorkspaceView));
  await view.findByRole("alert");
  fireEvent.click(view.getByRole("button", { name: "Refresh dispatches" }));
  expect(await view.findByText("WB-DEMO-1")).toBeTruthy();
});

// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HandoffSummary } from "@/lib/workbench";
import { HandoffsWorkspace } from "./handoffs-workspace";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const stale: HandoffSummary = {
  eventId: "event-1", caseId: "case-1", scenarioId: "S0", legIndex: 5,
  parcel: { epc: "urn:epc:id:sgtin:1", waybillNo: "WB-STALE", idKind: "waybill", onThisShipment: true },
  courier: { courierId: "CR-1", displayName: "Demo courier" }, bizStep: "delivering", eventTime: "2026-10-24T02:00:00Z",
  state: "awaiting_evidence", priority: 400, reason: "Evidence requested", shortReason: "Waiting for courier",
  matrixCell: "low-single/low-pattern", abort: null, inboxGroup: "waiting", stateProvenance: "computed", ageMinutes: 2,
  decision: null, sealed: false, inconsistency: { score: 0, evaluable: true, source: "evaluated", reason: null },
  pattern: { score: 0, evaluable: true, source: "evaluated", reason: null }, coverageLine: "16 of 16 checks evaluable",
  gateBasis: "both_axes", requiresCosign: true,
  provenance: { event: "synthetic", attestation: "mocked", pattern: "evaluated", explanation: { source: "unavailable", modelId: null } },
};
const fresh: HandoffSummary = { ...stale, state: "evidence_submitted", shortReason: "Courier response ready" };
const summary = { automaticallyAccepted: 0, total: 1, timeframe: "Demo window", from: stale.eventTime, to: stale.eventTime };
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });

it.each(["inbox", "all"] as const)("loads latest %s records over stale props and preserves the scenario filter", async (mode) => {
  const outside = { ...fresh, scenarioId: "S1", eventId: "outside", parcel: { ...fresh.parcel, waybillNo: "WB-OTHER-SCENARIO" } };
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/operator/dispatches") return response({ couriers: [], items: [] });
    if (url === "/api/operator/inbox") return response({ items: [fresh, outside] });
    if (url === "/api/operator/handoffs") return response({ items: [fresh, outside], summary: { ...summary, total: 2 } });
    throw new Error(`Unexpected API ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(createElement(HandoffsWorkspace, { mode, queueItems: [stale], allItems: [stale], summary, scenario: "S0" }));
  await waitFor(() => expect(view.getAllByText("Evidence submitted").length).toBeGreaterThan(0));
  expect(view.queryByText("Waiting for courier")).toBeNull();
  expect(view.queryByText("WB-OTHER-SCENARIO")).toBeNull();
  expect(view.getByRole("link", { name: "Inbox queue 1" }).getAttribute("href")).toBe("/operator/inbox?scenario=S0");
  expect(view.getByRole("link", { name: "All handoffs 1" })).toBeTruthy();
  expect(view.getByText("0 of 1")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/operator/inbox", { cache: "no-store" });
  expect(fetchMock).toHaveBeenCalledWith("/api/operator/handoffs", { cache: "no-store" });
});

it("keeps current rows through a failed refresh and adopts a later retry without losing search", async () => {
  let failRefresh = false;
  let current = stale;
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/operator/dispatches") return response({ couriers: [], items: [] });
    if (failRefresh) return response({ error: "Handoff snapshot unavailable" }, false);
    return response(url === "/api/operator/inbox" ? { items: [current] } : { items: [current], summary });
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(createElement(HandoffsWorkspace, { mode: "inbox", queueItems: [stale], allItems: [stale], summary }));
  await waitFor(() => expect((view.getByRole("button", { name: "Refresh handoffs" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(view.getByRole("textbox", { name: "Search parcel or courier" }), { target: { value: "WB-STALE" } });
  failRefresh = true;
  fireEvent.click(view.getByRole("button", { name: "Refresh handoffs" }));
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Handoff snapshot unavailable"));
  expect(view.getAllByText("WB-STALE").length).toBeGreaterThan(0);
  expect(view.getAllByText("Waiting for courier").length).toBeGreaterThan(0);
  failRefresh = false;
  current = fresh;
  fireEvent.click(view.getByRole("button", { name: "Refresh handoffs" }));
  await waitFor(() => expect(view.getAllByText("Evidence submitted").length).toBeGreaterThan(0));
  expect(view.queryByRole("alert")).toBeNull();
  expect((view.getByRole("textbox", { name: "Search parcel or courier" }) as HTMLInputElement).value).toBe("WB-STALE");
});

it("keeps the current snapshot visible while a refresh is pending", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  const fetchMock = vi.fn((url: string) => {
    if (url === "/api/operator/dispatches") return Promise.resolve(response({ couriers: [], items: [] }));
    if (url === "/api/operator/inbox") return Promise.resolve(response({ items: [fresh] }));
    return new Promise<ReturnType<typeof response>>((resolve) => { finish = resolve; });
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(createElement(HandoffsWorkspace, { mode: "all", queueItems: [stale], allItems: [stale], summary }));
  expect(view.getAllByText("Waiting for courier").length).toBeGreaterThan(0);
  expect((view.getByRole("button", { name: "Refresh handoffs" }) as HTMLButtonElement).disabled).toBe(true);
  expect(view.queryByText("Evidence submitted")).toBeNull();
  finish(response({ items: [fresh], summary }));
  await waitFor(() => expect(view.getAllByText("Evidence submitted").length).toBeGreaterThan(0));
});

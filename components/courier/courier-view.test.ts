// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { CourierQueueItem, CourierWorkspaceView } from "@/lib/workbench/service";
import { CourierView } from "./courier-view";

vi.mock("next/navigation", () => ({ usePathname: () => "/courier" }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const items: CourierQueueItem[] = ["registered", "online", "seeded"].map((source, i) => ({
  handoffId: `${source}:item-${i}`,
  source: source as CourierQueueItem["source"],
  courierId: "CR-1001",
  scenarioId: source === "seeded" ? "S1" : `B-${i}`,
  runId: source === "seeded" ? "S1" : `B-${i}`,
  title: `Delivery scan ${i}`, epc: `epc-${i}`, waybillNo: `WB-${i}`,
  route: {
    origin: { label: `KL pickup ${i}`, source: "registered", coordinate: null, senderClaim: null },
    destination: { label: `KL address ${i}`, source: "registered", coordinate: null, senderClaim: null },
  },
  leg: "delivery", eventTime: "2026-09-16T10:00:00+08:00",
  eventId: `event-${i}`, fault: source === "registered" ? "gps_spoof" : null, attempts: [],
  operatorSeal: null,
}));
const workspace: CourierWorkspaceView = {
  identity: { role: "courier", label: "Yee Ling Krishnan", subject: "CR-1001", keyFingerprint: "ed25519:1234…5678" },
  items,
};

describe("Courier prepared handoff workspace", () => {
  it("replaces the server snapshot with identity and items from one API response", async () => {
    const initial: CourierWorkspaceView = {
      identity: { role: "courier", label: "Wrong courier", subject: "CR-0000", keyFingerprint: null },
      items: [],
    };
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => workspace });
    vi.stubGlobal("fetch", fetcher);
    const view = render(createElement(CourierView, { initial }));
    await waitFor(() => expect(view.getByText("Yee Ling Krishnan")).toBeTruthy());
    expect(view.getByText("Acting courier: CR-1001")).toBeTruthy();
    expect(view.getByText("3 handoffs")).toBeTruthy();
    expect(view.getAllByText("Registered location").length).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledWith("/api/courier/handoffs", { cache: "no-store" });
  });

  it("selects a handoff locally without submitting it", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => workspace });
    vi.stubGlobal("fetch", fetcher);
    const view = render(createElement(CourierView, { initial: workspace }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: /Delivery scan 1/ }));
    expect(view.getByRole("heading", { name: "Delivery scan 1" })).toBeTruthy();
    expect(view.getByText("event-1")).toBeTruthy();
  });

  it("renders the submission response without a second queue read", async () => {
    const updated = { ...workspace, identity: { ...workspace.identity, label: "Confirmed courier" }, items: [{ ...items[1], attempts: [{
      run: { run: 1, eventHash: "hash", decision: "accept", halted: null, sealed: true, ledgerStatus: "recorded", credential: null, trace: [] },
      outcome: { kind: "sealed", headline: "Recorded", detail: "Verified and sealed.", sealed: true, problems: [] },
    }] }] };
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => workspace })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ workspace: updated }) })
      .mockRejectedValue(new Error("queue read must not be required"));
    vi.stubGlobal("fetch", fetcher);
    const view = render(createElement(CourierView, { initial: workspace }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: /Delivery scan 1/ }));
    fireEvent.click(view.getByRole("button", { name: "Submit without signing" }));
    await waitFor(() => expect(view.getByText("Recorded in the ledger.")).toBeTruthy());
    expect(view.getByText("Confirmed courier")).toBeTruthy();
    expect(view.getByRole("button", { name: "Submit again" })).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]).toEqual(["/api/courier/handoffs/online%3Aitem-1/submit", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signed: false, courierId: "CR-1001" }),
    }]);
  });

  it("reports an incomplete submission response without inventing an outcome", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => workspace })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetcher);
    const view = render(createElement(CourierView, { initial: workspace }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: "Sign and submit" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("updated courier queue"));
    expect(fetcher.mock.calls[1][1].body).toBe(JSON.stringify({ signed: true, courierId: "CR-1001" }));
    expect(view.queryByText("Recorded in the ledger.")).toBeNull();
  });

  it("does not let a late initial queue response erase a successful submission", async () => {
    let finishInitial!: (response: unknown) => void;
    const initialRead = new Promise((resolve) => { finishInitial = resolve; });
    const updated = { ...workspace, identity: { ...workspace.identity, label: "Confirmed courier" } };
    const fetcher = vi.fn().mockReturnValueOnce(initialRead)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ workspace: updated }) });
    vi.stubGlobal("fetch", fetcher);
    const view = render(createElement(CourierView, { initial: workspace }));
    fireEvent.click(view.getByRole("button", { name: "Sign and submit" }));
    await view.findByText("Confirmed courier");
    finishInitial({ ok: true, json: async () => workspace });
    await waitFor(() => expect(view.queryByText("Yee Ling Krishnan")).toBeNull());
    expect(view.getByText("Confirmed courier")).toBeTruthy();
  });

  it("shows repeat and full history only for actual recorded attempts", () => {
    const attempt: CourierQueueItem["attempts"][number] = {
      run: { run: 1, eventHash: "test-hash", decision: "accept", halted: null, sealed: true, ledgerStatus: "recorded", credential: null, trace: [] },
      outcome: { kind: "sealed", headline: "Recorded", detail: "Verified and sealed.", sealed: true, problems: [] },
    };
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const view = render(createElement(CourierView, { initial: { ...workspace, items: [{ ...items[0], attempts: [attempt] }] } }));
    expect(view.getByRole("button", { name: "Submit again" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Submit without signing" })).toBeNull();
    expect(view.queryByText("Submission history")).toBeNull();
    view.unmount();
    const history = render(createElement(CourierView, { initial: { ...workspace, items: [{ ...items[0], attempts: [attempt, { ...attempt, run: { ...attempt.run, run: 2 } }] }] } }));
    expect(history.getByText("Submission history")).toBeTruthy();
  });

  it("shows the operator seal as an unnumbered lifecycle step", () => {
    const attempt: CourierQueueItem["attempts"][number] = {
      run: { run: 1, eventHash: "test-hash", decision: null, halted: { at: "gate", reason: "PENDING_COSIGNATURE" }, sealed: false, ledgerStatus: null, credential: null, trace: [] },
      outcome: { kind: "signature_insufficient", headline: "Signature valid, but insufficient", detail: "Waiting for an operator.", sealed: false, problems: [] },
    };
    const withSeal: CourierQueueItem = {
      ...items[1],
      attempts: [attempt],
      operatorSeal: { operatorId: "OP-01", createdAt: "2026-09-08T10:01:00.000Z", ledgerStatus: "recorded" },
    };

    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const view = render(createElement(CourierView, { initial: { ...workspace, items: [withSeal] } }));
    expect(view.getByText("Operator co-signed and sealed")).toBeTruthy();
    expect(view.getByText("OP-01")).toBeTruthy();
    expect(view.getByText("Operator co-signed and sealed").parentElement?.textContent).not.toMatch(/#\s*2/);
  });
});

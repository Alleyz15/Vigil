// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { CourierDraft } from "@/lib/workbench/service";
import { CourierView } from "./courier-view";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const drafts: CourierDraft[] = ["S0", "S1"].map((scenarioId, i) => ({
  draftId: `draft-${i}`, scenarioId: scenarioId as CourierDraft["scenarioId"],
  title: `Delivery scan ${i}`, epc: `epc-${i}`, waybillNo: `WB-${i}`,
  recipientAddress: `KL address ${i}`, leg: "delivery", eventTime: "2026-09-16T10:00:00+08:00",
  eventId: `event-${i}`, attempts: [],
}));

describe("Courier prepared handoff workspace", () => {
  it("selects a draft locally without submitting it", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const view = render(createElement(CourierView, { initial: drafts }));
    fireEvent.click(view.getByRole("button", { name: /Delivery scan 1/ }));
    expect(view.getByRole("heading", { name: "Delivery scan 1" })).toBeTruthy();
    expect(view.getByText("event-1")).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("submits only signed to the selected draft API and refreshes the real listing", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: drafts }) });
    vi.stubGlobal("fetch", fetcher);
    const view = render(createElement(CourierView, { initial: drafts }));
    fireEvent.click(view.getByRole("button", { name: /Delivery scan 1/ }));
    fireEvent.click(view.getByRole("button", { name: "Submit without signing" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[0]).toEqual(["/api/courier/drafts/draft-1/submit", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signed: false }),
    }]);
    expect(fetcher.mock.calls[1]).toEqual(["/api/courier/drafts", { cache: "no-store" }]);
  });

  it("keeps the signed submit contract and reports a failed refresh without inventing an outcome", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false });
    vi.stubGlobal("fetch", fetcher);
    const view = render(createElement(CourierView, { initial: drafts }));
    fireEvent.click(view.getByRole("button", { name: "Sign and submit" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Submission may have completed"));
    expect(fetcher.mock.calls[0][1].body).toBe(JSON.stringify({ signed: true }));
    expect(view.queryByText("Recorded in the ledger.")).toBeNull();
  });

  it("shows repeat and full history only for actual recorded attempts", () => {
    const attempt: CourierDraft["attempts"][number] = {
      run: { run: 1, eventHash: "test-hash", decision: "accept", halted: null, sealed: true, ledgerStatus: "recorded", credential: null, trace: [] },
      outcome: { kind: "sealed", headline: "Recorded", detail: "Verified and sealed.", sealed: true, problems: [] },
    };
    const view = render(createElement(CourierView, { initial: [{ ...drafts[0], attempts: [attempt] }] }));
    expect(view.getByRole("button", { name: "Submit again" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Submit without signing" })).toBeNull();
    expect(view.queryByText("Submission history")).toBeNull();
    view.unmount();
    const history = render(createElement(CourierView, { initial: [{ ...drafts[0], attempts: [attempt, { ...attempt, run: { ...attempt.run, run: 2 } }] }] }));
    expect(history.getByText("Submission history")).toBeTruthy();
  });
});

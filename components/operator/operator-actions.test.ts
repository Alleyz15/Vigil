// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HandoffDetail, HandoffState } from "@/lib/workbench";
import { OperatorActions } from "./operator-actions";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness({ state = "awaiting_cosignature", sealed = false, canApprove = true }: {
  state?: HandoffState; sealed?: boolean; canApprove?: boolean;
}) {
  const [detail, setDetail] = useState<HandoffDetail>({ summary: { state, sealed }, canApprove } as HandoffDetail);
  return createElement("div", null,
    createElement("p", null, `Case: ${detail.summary.state}`),
    createElement(OperatorActions, {
      eventId: "event-1", state: detail.summary.state, sealed: detail.summary.sealed,
      canApprove: detail.canApprove, rerouteAvailable: false, rerouteReason: "No authorised reroute.", onDetailChange: setDetail,
    }),
  );
}

it("requires a nonempty request note and renders the returned case without a refetch", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ summary: { state: "awaiting_evidence", sealed: false }, canApprove: false }) });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(createElement(Harness));
  fireEvent.click(view.getByRole("button", { name: "Request evidence" }));
  const note = view.getByRole("textbox", { name: "Evidence request note" });
  fireEvent.change(note, { target: { value: "   " } });
  expect((view.getByRole("button", { name: "Send request" }) as HTMLButtonElement).disabled).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.change(note, { target: { value: "Explain the recipient address mismatch." } });
  fireEvent.click(view.getByRole("button", { name: "Send request" }));
  await waitFor(() => expect(view.getByText("Case: awaiting_evidence")).toBeTruthy());
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/operator/handoffs/event-1/actions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "request_evidence", note: "Explain the recipient address mismatch." }),
  });
  expect(view.queryByRole("textbox")).toBeNull();
  expect((view.getByRole("button", { name: "Request evidence" }) as HTMLButtonElement).disabled).toBe(true);
});

it("keeps the note after a network failure and disables every action while submitting", async () => {
  let reject!: (error: Error) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((_, fail) => { reject = fail; })));
  const view = render(createElement(Harness));
  fireEvent.click(view.getByRole("button", { name: "Request evidence" }));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "Please explain the scan." } });
  fireEvent.click(view.getByRole("button", { name: "Send request" }));
  for (const button of view.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
  reject(new Error("Connection lost"));
  await waitFor(() => expect(view.getByRole("alert").textContent).toMatch(/could not|connection/i));
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Please explain the scan.");
  expect((view.getByRole("button", { name: "Send request" }) as HTMLButtonElement).disabled).toBe(false);
});

it("preserves a draft after an API rejection and can cancel without posting", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Evidence service unavailable" }) });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(createElement(Harness));
  fireEvent.click(view.getByRole("button", { name: "Request evidence" }));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "Clarify who received it." } });
  fireEvent.click(view.getByRole("button", { name: "Send request" }));
  await waitFor(() => expect(view.getByRole("alert").textContent).toBe("Evidence service unavailable"));
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Clarify who received it.");
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  expect(view.queryByRole("textbox")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("allows eligible submitted evidence to be co-signed or requested again", () => {
  const view = render(createElement(Harness, { state: "evidence_submitted" as HandoffState }));
  expect(view.getByRole("button", { name: "Approve and co-sign" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Request evidence" }));
  expect(view.getByRole("textbox", { name: "Evidence request note" })).toBeTruthy();
});

it.each([
  { state: "awaiting_cosignature", sealed: false, canApprove: false },
  { state: "evidence_submitted", sealed: true, canApprove: true },
])("never offers approval when disallowed or already sealed: %j", (props) => {
  const view = render(createElement(Harness, { ...props, state: props.state as HandoffState }));
  expect(view.queryByRole("button", { name: "Approve and co-sign" })).toBeNull();
});

it("shows a resolved unsealed case as closed without actions", () => {
  const view = render(createElement(Harness, { state: "resolved_rejected" }));
  expect(view.queryByRole("button")).toBeNull();
  expect(view.getByText(/No verdict was sealed/)).toBeTruthy();
});

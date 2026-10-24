// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { CourierQueueItem, CourierWorkspaceView, RoleIdentity } from "@/lib/workbench/service";
import type { CourierEvidenceItem } from "@/lib/workbench/operations-types";
import { CourierView } from "./courier-view";

vi.mock("next/navigation", () => ({ usePathname: () => "/courier" }));

const alice: RoleIdentity = { role: "courier", subject: "CR-1000", label: "Alice", keyFingerprint: "ed25519:alice" };
const bob: RoleIdentity = { role: "courier", subject: "CR-1001", label: "Bob", keyFingerprint: "ed25519:bob" };
const route: CourierQueueItem["route"] = {
  origin: { label: "KL depot", source: "registered", coordinate: null, senderClaim: null },
  destination: { label: "Condo 12", source: "registered", coordinate: null, senderClaim: null },
};
const handoff: CourierQueueItem & { identity: RoleIdentity } = {
  handoffId: "online:one", source: "online", courierId: alice.subject, identity: alice,
  scenarioId: "B-1", runId: "B-1", title: "Delivery one", epc: "epc-one", waybillNo: "WB-one",
  route, leg: "delivery", eventTime: "2026-10-24T10:00:00+08:00", eventId: "event-one",
  fault: null, attempts: [], operatorSeal: null,
};
const evidence: CourierEvidenceItem = {
  request: { requestId: "request:one", eventId: "event-one", courierId: alice.subject, operatorId: "OP-01",
    note: "Please explain the delivery location.", requestedAt: "2026-10-24T10:01:00+08:00", submission: null },
  waybillNo: "WB-evidence", route, identity: { ...alice, keyFingerprint: "ed25519:evidence-world" },
  findings: [{ id: "I10", label: "Scan differs from recipient address" }], state: "awaiting_evidence",
};
type Workspace = CourierWorkspaceView & { couriers?: RoleIdentity[]; evidenceRequests?: CourierEvidenceItem[] };
const workspace: Workspace = { identity: alice, couriers: [alice, bob], items: [handoff], evidenceRequests: [evidence] };
const ok = (payload: unknown) => ({ ok: true, json: async () => payload });
function deferred() {
  let resolve!: (value: ReturnType<typeof ok>) => void;
  const promise = new Promise<ReturnType<typeof ok>>((done) => { resolve = done; });
  return { promise, resolve };
}
function mount(initial: Workspace = workspace, fetcher = vi.fn().mockResolvedValue(ok(initial))) {
  vi.stubGlobal("fetch", fetcher);
  return { view: render(createElement(CourierView, { initial })), fetcher };
}
async function openEvidence(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole("button", { name: /Evidence requests/ }));
  await view.findByRole("textbox", { name: "Explanation" });
}
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  window.history.replaceState(null, "", "/courier");
});

describe("Courier demo identity selection", () => {
  it("reads the page actor query and keeps the actual selected handoff fingerprint", async () => {
    window.history.replaceState(null, "", "/courier?courierId=CR-1000");
    const second = { ...handoff, handoffId: "seeded:two", title: "Delivery two", identity: { ...alice, keyFingerprint: "ed25519:other-world" } };
    const { view, fetcher } = mount({ ...workspace, items: [handoff, second] });
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/courier/handoffs?courierId=CR-1000", { cache: "no-store" }));
    expect(view.getByLabelText("Demo courier identity")).toBeTruthy();
    expect(view.getByText(/Not authentication/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: /Delivery two/ }));
    expect(view.getByText("ed25519:other-world")).toBeTruthy();
    expect(view.queryByText("ed25519:alice")).toBeNull();
  });

  it("ignores a slower actor response when another actor was selected", async () => {
    const slow = deferred(); const fast = deferred();
    const fetcher = vi.fn().mockResolvedValueOnce(ok(workspace)).mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const { view } = mount(workspace, fetcher);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const selector = view.getByLabelText("Demo courier identity");
    fireEvent.change(selector, { target: { value: bob.subject } });
    fireEvent.change(selector, { target: { value: alice.subject } });
    await act(async () => fast.resolve(ok(workspace)));
    await act(async () => slow.resolve(ok({ ...workspace, identity: bob, items: [], evidenceRequests: [] })));
    expect(view.getByText("Acting courier: CR-1000")).toBeTruthy();
    expect(view.queryByText("Acting courier: CR-1001")).toBeNull();
    expect(fetcher.mock.calls[1][0]).toBe("/api/courier/handoffs?courierId=CR-1001");
    expect(window.location.search).toBe("?courierId=CR-1000");
  });

  it("blocks identity switches and duplicate posts during handoff submission and sends courierId", async () => {
    const post = deferred();
    const fetcher = vi.fn().mockResolvedValueOnce(ok(workspace)).mockReturnValueOnce(post.promise);
    const { view } = mount(workspace, fetcher);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const submit = view.getByRole("button", { name: "Sign and submit" });
    fireEvent.click(submit); fireEvent.click(submit);
    fireEvent.change(view.getByLabelText("Demo courier identity"), { target: { value: bob.subject } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ signed: true, courierId: alice.subject });
    expect((view.getByLabelText("Demo courier identity") as HTMLSelectElement).disabled).toBe(true);
    await act(async () => post.resolve(ok({ workspace })));
  });

  it("shows server actor errors and blocks submission until a failed switch is recovered", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(ok(workspace))
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "unknown courier" }) });
    const { view } = mount(workspace, fetcher);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    fireEvent.change(view.getByLabelText("Demo courier identity"), { target: { value: bob.subject } });
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("unknown courier"));
    expect(view.queryByRole("button", { name: "Sign and submit" })).toBeNull();
  });

  it("hides the previous actor's work during a switch and rejects a mismatched queue response", async () => {
    const response = deferred();
    const fetcher = vi.fn().mockResolvedValueOnce(ok(workspace)).mockReturnValueOnce(response.promise);
    const { view } = mount(workspace, fetcher);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    fireEvent.change(view.getByLabelText("Demo courier identity"), { target: { value: bob.subject } });
    expect(view.queryByText("Delivery one")).toBeNull();
    expect(view.queryByText("ed25519:alice")).toBeNull();
    expect(view.queryByRole("button", { name: "Sign and submit" })).toBeNull();
    await act(async () => response.resolve(ok(workspace)));
    expect(view.getByRole("alert").textContent).toContain("did not match");
    expect(view.queryByRole("button", { name: "Sign and submit" })).toBeNull();
  });
});

describe("Courier supporting evidence", () => {
  it("shows its own request, shipment, findings, operator note and actual key, without risk scores", async () => {
    const { view } = mount();
    await openEvidence(view);
    expect(within(view.getByRole("region", { name: "Selected evidence request" })).getByText(evidence.request.note)).toBeTruthy();
    expect(view.getByText("Scan differs from recipient address")).toBeTruthy();
    expect(view.getAllByText("WB-evidence").length).toBeGreaterThan(0);
    expect(view.getAllByText("Condo 12").length).toBeGreaterThan(0);
    expect(view.getByText("ed25519:evidence-world")).toBeTruthy();
    expect(view.queryByText(/risk score|pattern score/i)).toBeNull();
    expect((view.getByRole("button", { name: "Submit evidence" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(view.getByRole("textbox", { name: "Explanation" }), { target: { value: "   " } });
    expect((view.getByRole("button", { name: "Submit evidence" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("submits multipart once, preserves the draft on error and reuses its UUID on retry", async () => {
    const pending = deferred();
    const fetcher = vi.fn().mockResolvedValueOnce(ok(workspace)).mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(ok({ workspace: { ...workspace, evidenceRequests: [{ ...evidence, state: "evidence_submitted", request: { ...evidence.request,
        submission: { submissionId: "receipt-one", explanation: "The lobby was closed.", submittedAt: "2026-10-24T10:02:00Z", attachments: [] } } }] } }));
    const { view } = mount(workspace, fetcher);
    await openEvidence(view);
    fireEvent.change(view.getByRole("textbox", { name: "Explanation" }), { target: { value: "The lobby was closed." } });
    const file = new File(["%PDF-1.7"], "note.pdf", { type: "application/pdf" });
    fireEvent.change(view.getByLabelText("Attachments"), { target: { files: [file] } });
    const submit = view.getByRole("button", { name: "Submit evidence" });
    fireEvent.click(submit); fireEvent.click(submit);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, options] = fetcher.mock.calls[1];
    expect(url).toBe("/api/courier/evidence/request%3Aone");
    expect(options.method).toBe("POST");
    expect(options.headers).toBeUndefined();
    const form = options.body as FormData;
    expect(form.get("courierId")).toBe(alice.subject);
    expect(form.get("explanation")).toBe("The lobby was closed.");
    expect(form.getAll("files")).toEqual([file]);
    expect(form.get("submissionId")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    await act(async () => pending.resolve({ ok: false, json: async () => ({ error: "Upload unavailable; retry." }) }));
    expect(view.getByRole("alert").textContent).toContain("Upload unavailable");
    expect((view.getByRole("textbox", { name: "Explanation" }) as HTMLTextAreaElement).value).toBe("The lobby was closed.");
    expect(view.getByText("note.pdf")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Submit evidence" }));
    await view.findByText("Evidence submitted");
    expect((fetcher.mock.calls[2][1].body as FormData).get("submissionId")).toBe(form.get("submissionId"));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(view.queryByRole("textbox", { name: "Explanation" })).toBeNull();
    expect(view.getByText("receipt-one")).toBeTruthy();
  });

  it.each([
    ["unsupported MIME", [new File(["x"], "bad.jpg", { type: "text/plain" })], /JPEG, PNG or PDF/],
    ["unsupported extension", [new File(["x"], "bad.exe", { type: "image/png" })], /JPEG, PNG or PDF/],
    ["MIME extension mismatch", [new File(["x"], "bad.png", { type: "application/pdf" })], /JPEG, PNG or PDF/],
    ["oversized file", [new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" })], /5 MiB/],
    ["too many files", Array.from({ length: 4 }, (_, i) => new File(["x"], `${i}.pdf`, { type: "application/pdf" })), /three|3/],
  ])("rejects %s before submitting", async (_label, files, message) => {
    const { view, fetcher } = mount(); await openEvidence(view);
    fireEvent.change(view.getByLabelText("Attachments"), { target: { files } });
    expect(view.getByRole("alert").textContent).toMatch(message);
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const file of files) expect(view.queryByRole("button", { name: `Remove ${file.name}` })).toBeNull();
  });

  it("previews local images and releases object URLs on removal and unmount", async () => {
    const create = vi.fn().mockReturnValueOnce("blob:photo-one").mockReturnValueOnce("blob:photo-two");
    const revoke = vi.fn();
    const originalCreate = URL.createObjectURL; const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = create; URL.revokeObjectURL = revoke;
    try {
      const { view } = mount(); await openEvidence(view);
      const photo = new File(["image"], "door.jpg", { type: "image/jpeg" });
      fireEvent.change(view.getByLabelText("Attachments"), { target: { files: [photo] } });
      expect((await view.findByRole("img", { name: "door.jpg" })).getAttribute("src")).toBe("blob:photo-one");
      fireEvent.click(view.getByRole("button", { name: "Remove door.jpg" }));
      expect(revoke).toHaveBeenCalledWith("blob:photo-one");
      fireEvent.change(view.getByLabelText("Attachments"), { target: { files: [photo] } });
      await view.findByRole("img", { name: "door.jpg" });
      view.unmount(); expect(revoke).toHaveBeenCalledWith("blob:photo-two");
    } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
  });

  it("keeps drafts separate between request rounds and refreshes the selected actor", async () => {
    const second: CourierEvidenceItem = { ...evidence, request: { ...evidence.request, requestId: "request-two", note: "Please send the receipt." }, waybillNo: "WB-two" };
    const listing = { ...workspace, evidenceRequests: [evidence, second] };
    const { view, fetcher } = mount(listing); await openEvidence(view);
    fireEvent.change(view.getByRole("textbox", { name: "Explanation" }), { target: { value: "First round explanation" } });
    fireEvent.click(view.getByRole("button", { name: /WB-two/ }));
    expect((view.getByRole("textbox", { name: "Explanation" }) as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(view.getByRole("button", { name: /WB-evidence/ }));
    expect((view.getByRole("textbox", { name: "Explanation" }) as HTMLTextAreaElement).value).toBe("First round explanation");
    fireEvent.click(view.getByRole("button", { name: "Refresh requests" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toBe("/api/courier/handoffs?courierId=CR-1000");
    expect((view.getByRole("textbox", { name: "Explanation" }) as HTMLTextAreaElement).value).toBe("First round explanation");
  });

  it("renders submitted history and courier-scoped download links even when resolved", async () => {
    const submitted: CourierEvidenceItem = { ...evidence, state: "resolved_rejected", request: { ...evidence.request,
      submission: { submissionId: "receipt-resolved", explanation: "My supporting explanation", submittedAt: "2026-10-24T10:02:00Z",
        attachments: [{ attachmentId: "attachment:one", name: "receipt.pdf", mimeType: "application/pdf", size: 10, sha256: "abcd" }] } } };
    const { view } = mount({ ...workspace, evidenceRequests: [submitted] });
    fireEvent.click(view.getByRole("button", { name: /Evidence requests/ }));
    expect(await view.findByText("My supporting explanation")).toBeTruthy();
    expect(view.getByRole("link", { name: /receipt.pdf/ }).getAttribute("href")).toBe("/api/evidence/attachments/attachment%3Aone?courierId=CR-1000");
    expect(view.queryByRole("textbox", { name: "Explanation" })).toBeNull();
    expect(view.queryByRole("button", { name: "Submit evidence" })).toBeNull();
  });

  it("does not edit a resolved round that has no submission", async () => {
    const { view } = mount({ ...workspace, evidenceRequests: [{ ...evidence, state: "resolved_escalated" }] });
    fireEvent.click(view.getByRole("button", { name: /Evidence requests/ }));
    expect(within(await view.findByRole("region", { name: "Selected evidence request" })).getByText(/Resolved/)).toBeTruthy();
    expect(view.queryByRole("textbox", { name: "Explanation" })).toBeNull();
  });

  it("accepts three permitted files including the exact size boundary, retaining them after a rejected batch", async () => {
    const { view } = mount(); await openEvidence(view);
    const files = [
      new File([new Uint8Array(5 * 1024 * 1024)], "receipt.pdf", { type: "application/pdf" }),
      new File(["image"], "door.jpeg", { type: "image/jpeg" }),
      new File(["image"], "lobby.png", { type: "image/png" }),
    ];
    const originalCreate = URL.createObjectURL; const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => "blob:preview"; URL.revokeObjectURL = () => {};
    try {
      fireEvent.change(view.getByLabelText("Attachments"), { target: { files } });
      for (const file of files) expect(view.getByRole("button", { name: `Remove ${file.name}` })).toBeTruthy();
      expect(view.queryByRole("alert")).toBeNull();
      fireEvent.change(view.getByLabelText("Attachments"), { target: { files: [files[0]] } });
      expect(view.getByRole("alert").textContent).toContain("three");
      for (const file of files) expect(view.getByRole("button", { name: `Remove ${file.name}` })).toBeTruthy();
      view.unmount();
    } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
  });

  it("keeps an explanation on rejected or incomplete responses and permits text-only submission", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(ok(workspace))
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "wrong courier" }) })
      .mockResolvedValueOnce(ok({}));
    const { view } = mount(workspace, fetcher); await openEvidence(view);
    fireEvent.change(view.getByRole("textbox", { name: "Explanation" }), { target: { value: "Recipient met me outside." } });
    fireEvent.click(view.getByRole("button", { name: "Submit evidence" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("wrong courier"));
    const form = fetcher.mock.calls[1][1].body as FormData;
    expect(form.getAll("files")).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: "Submit evidence" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("updated courier queue"));
    expect((view.getByRole("textbox", { name: "Explanation" }) as HTMLTextAreaElement).value).toBe("Recipient met me outside.");
    expect((fetcher.mock.calls[2][1].body as FormData).get("submissionId")).toBe(form.get("submissionId"));
    expect(view.queryByText("Evidence submitted")).toBeNull();
  });

  it("keeps courier drafts separate and lets an evidence response supersede a stale refresh", async () => {
    const bobRequest: CourierEvidenceItem = { ...evidence, identity: bob, request: { ...evidence.request, requestId: "bob-request", courierId: bob.subject } };
    const bobWorkspace = { ...workspace, identity: bob, items: [], evidenceRequests: [bobRequest] };
    const stale = deferred();
    const submitted = { ...evidence, state: "evidence_submitted", request: { ...evidence.request,
      submission: { submissionId: "fresh-receipt", explanation: "Alice response", submittedAt: "2026-10-24T10:03:00Z", attachments: [] } } };
    const fetcher = vi.fn().mockResolvedValueOnce(ok(workspace)).mockResolvedValueOnce(ok(bobWorkspace))
      .mockResolvedValueOnce(ok(workspace)).mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(ok({ workspace: { ...workspace, evidenceRequests: [submitted] } }));
    const { view } = mount(workspace, fetcher); await openEvidence(view);
    fireEvent.change(view.getByRole("textbox", { name: "Explanation" }), { target: { value: "Alice response" } });
    fireEvent.change(view.getByLabelText("Demo courier identity"), { target: { value: bob.subject } });
    await view.findByRole("textbox", { name: "Explanation" });
    expect((view.getByRole("textbox", { name: "Explanation" }) as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(view.getByRole("textbox", { name: "Explanation" }), { target: { value: "Bob response" } });
    fireEvent.change(view.getByLabelText("Demo courier identity"), { target: { value: alice.subject } });
    await view.findByRole("textbox", { name: "Explanation" });
    expect((view.getByRole("textbox", { name: "Explanation" }) as HTMLTextAreaElement).value).toBe("Alice response");
    fireEvent.click(view.getByRole("button", { name: "Refresh requests" }));
    fireEvent.click(view.getByRole("button", { name: "Submit evidence" }));
    await view.findByText("fresh-receipt");
    await act(async () => stale.resolve(ok(workspace)));
    expect(view.getByText("fresh-receipt")).toBeTruthy();
    expect(view.queryByRole("textbox", { name: "Explanation" })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});

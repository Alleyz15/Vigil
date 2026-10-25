// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HandoffDetail, HandoffState, HandoffSummary } from "@/lib/workbench";
import type { EvidenceRequestView } from "@/lib/workbench/operations-types";
import { HandoffDetailView } from "./handoff-detail";
import { InboxTable } from "./inbox-table";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const summary: HandoffSummary = {
  eventId: "event-1", caseId: "case-1", scenarioId: "S0", legIndex: 5,
  parcel: { epc: "urn:epc:id:sgtin:1", waybillNo: "WB-EVIDENCE", idKind: "waybill", onThisShipment: true },
  courier: { courierId: "CR-1", displayName: "Demo courier" }, bizStep: "delivering", eventTime: "2026-10-24T02:00:00Z",
  state: "evidence_submitted" as HandoffState, priority: 400, reason: "Evidence returned", shortReason: "Evidence returned",
  matrixCell: "low-single/low-pattern", abort: null, inboxGroup: "other", stateProvenance: "computed", ageMinutes: 2,
  decision: null, sealed: false, inconsistency: { score: 0, evaluable: true, source: "evaluated", reason: null },
  pattern: { score: 0, evaluable: true, source: "evaluated", reason: null }, coverageLine: "16 of 16 checks evaluable",
  gateBasis: "both_axes", requiresCosign: true,
  provenance: { event: "synthetic", attestation: "mocked", pattern: "evaluated", explanation: { source: "unavailable", modelId: null } },
};
const rounds: EvidenceRequestView[] = [
  { requestId: "round-1", eventId: "event-1", courierId: "CR-1", operatorId: "OP-1", note: "Explain the address discrepancy.",
    requestedAt: "2026-10-24T02:00:00Z", submission: { submissionId: "submission-1", explanation: "The recipient met me at the lobby.",
      submittedAt: "2026-10-24T02:05:00Z", attachments: [{ attachmentId: "attachment-1", name: "lobby.pdf", mimeType: "application/pdf", size: 256, sha256: "a".repeat(64) }] } },
  { requestId: "round-2", eventId: "event-1", courierId: "CR-1", operatorId: "OP-1", note: "Clarify the lobby entrance.",
    requestedAt: "2026-10-24T02:10:00Z", submission: null },
];
function detail(overrides: Partial<HandoffDetail> = {}): HandoffDetail {
  return {
    summary, route: null, event: {}, checks: { singleEvent: [], pattern: [] }, flags: [], abortEvidence: null,
    gate: { decision: "accept", matrixCell: "low-single/low-pattern", rationale: null, cosignReasons: ["Operator signature required"] },
    cosignPolicyEvidence: [], credential: { valid: false, courierValid: true, operatorValid: false, cosignRequired: true, problems: [] },
    ledger: { sequence: null, chainValid: true, entries: 0 }, recipientConfirmation: null,
    addressCorrection: null, locationEvidence: null,
    authoritativeRun: { run: 1, eventHash: "event-hash", decision: "accept", halted: { at: "gate", reason: "PENDING_COSIGNATURE" },
      sealed: false, ledgerStatus: null, credential: null, trace: [] },
    runs: [], actions: [], timeline: [], map: { route: [], locations: [], overlays: [], notices: [] },
    planConsidered: [], plan: { selectedTools: [], rationale: null, source: "heuristic", rejection: null, modelId: null, runtimeReason: null },
    externalContext: null, toolResults: [], reroute: null,
    explanation: { text: null, source: "unavailable", rejection: null, modelId: null, runtimeReason: "MODEL_RUNTIME_DISABLED", citations: [] },
    verdictHash: null, supportingEvidence: rounds, canApprove: true, ...overrides,
  };
}
function rendered(value: HandoffDetail) {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(createElement(HandoffDetailView, { detail: value }));
  return within(root);
}

it("contains a long delivery address in its timeline slot while retaining the complete label", () => {
  const address = "Ampang, Sungai Besi-Ulu Klang Elevated Expressway, Taman Dagang, Kampung Indah Permai, Kampung Tasik Permai, Ampang Jaya Municipal Council, Hulu Langat, Selangor, 68000, Malaysia";
  const view = rendered(detail({ timeline: [{ ...summary, locationLabel: address }] }));
  const timeline = within(view.getByRole("list", { name: "Shipment legs" }));
  const button = timeline.getByRole("button", { name: /Delivering/i });
  expect(button.getAttribute("title")).toBe(address);
  expect(button.classList.contains("grid-rows-[1rem_1rem_2rem_1rem]")).toBe(true);
  expect(button.classList.contains("overflow-hidden")).toBe(true);
  const label = timeline.getByText(address);
  expect(label.classList.contains("line-clamp-2")).toBe(true);
  expect(label.classList.contains("block")).toBe(false);
  expect(label.classList.contains("max-h-8")).toBe(true);
  expect(timeline.getByText("02:00")).toBeTruthy();
});

it("shows evidence round notes, explanations, download integrity and timestamps separately from rule evidence", () => {
  const view = rendered(detail());
  const evidence = within(view.getByRole("region", { name: "Supporting evidence" }));
  expect(evidence.getByText("Round 1")).toBeTruthy();
  expect(evidence.getByText("Round 2")).toBeTruthy();
  expect(evidence.getByText("Explain the address discrepancy.")).toBeTruthy();
  expect(evidence.getByText("The recipient met me at the lobby.")).toBeTruthy();
  expect(evidence.getByText("Clarify the lobby entrance.")).toBeTruthy();
  expect(evidence.getByRole("link", { name: /lobby.pdf/ }).getAttribute("href")).toBe("/api/evidence/attachments/attachment-1?role=operator");
  expect(evidence.getByText("a".repeat(64))).toBeTruthy();
  expect(evidence.getByText("2026-10-24T02:05:00Z")).toBeTruthy();
  expect(evidence.getByText(/Attachments are unverified/).textContent).toMatch(/do not change.*scores.*prove delivery/i);
  expect(evidence.getByText(/SHA-256.*integrity.*truth/i)).toBeTruthy();
});

it("keeps terminal supporting evidence readable and marks a round without submission closed", () => {
  const view = rendered(detail({ summary: { ...summary, state: "resolved_rejected" } }));
  const evidence = within(view.getByRole("region", { name: "Supporting evidence" }));
  expect(evidence.getByText(/Closed.*read.only/i)).toBeTruthy();
  expect(evidence.getByRole("link", { name: /lobby.pdf/ })).toBeTruthy();
  expect(evidence.queryByText(/Awaiting courier submission/)).toBeNull();
  expect(view.queryByRole("button", { name: "Request evidence" })).toBeNull();
});

it.each(["resolved_rejected", "resolved_escalated"] as const)("shows an incomplete, unsealed credential separately from the closed case %s", (state) => {
  const view = rendered(detail({ summary: { ...summary, state, sealed: false }, canApprove: false }));
  const panel = view.getByRole("heading", { name: "Decision and credential" }).parentElement!.parentElement!;
  expect(within(panel).getByText(/incomplete.*not sealed/i)).toBeTruthy();
  expect(within(panel).queryByText("pending")).toBeNull();
  expect(view.getByText(state === "resolved_rejected" ? "Rejected by operator" : "Escalated")).toBeTruthy();
  expect(view.getByText(/No verdict was sealed; the operator disposition closed/)).toBeTruthy();
});

it("keeps a rejected case's existing seal distinct from its operator disposition", () => {
  const view = rendered(detail({ summary: { ...summary, state: "resolved_rejected", sealed: true }, canApprove: false }));
  const panel = view.getByRole("heading", { name: "Decision and credential" }).parentElement!.parentElement!;
  expect(within(panel).getByText("sealed")).toBeTruthy();
  expect(within(panel).queryByText(/incomplete.*not sealed/i)).toBeNull();
  expect(view.getByText("Rejected by operator")).toBeTruthy();
});

it.each([{ supportingEvidence: [] }, { supportingEvidence: undefined }])("shows archived evidence without inventing a current round when current evidence is $supportingEvidence", ({ supportingEvidence }) => {
  const view = rendered(detail({ supportingEvidence, archivedEvidenceCount: 3 }));
  const evidence = within(view.getByRole("region", { name: "Supporting evidence" }));
  expect(evidence.getByText("3 archived evidence requests")).toBeTruthy();
  expect(evidence.getByText("Earlier workflow evidence is archived and is not applied to this run.")).toBeTruthy();
  expect(evidence.queryByRole("heading", { name: /^Round / })).toBeNull();
  expect(evidence.queryByRole("link", { name: /lobby.pdf/ })).toBeNull();
  expect(evidence.queryByText("The recipient met me at the lobby.")).toBeNull();
  expect(evidence.queryByRole("list")).toBeNull();
});

it("counts archived requests separately from the current workflow's rounds", () => {
  const view = rendered(detail({ supportingEvidence: [rounds[0]], archivedEvidenceCount: 3 }));
  const evidence = within(view.getByRole("region", { name: "Supporting evidence" }));
  expect(evidence.getByText("3 archived evidence requests")).toBeTruthy();
  expect(evidence.getByText("Round 1")).toBeTruthy();
  expect(evidence.queryByText("Round 4")).toBeNull();
  expect(evidence.getByText("The recipient met me at the lobby.")).toBeTruthy();
});

it("does not show an archive notice when no earlier workflow evidence exists", () => {
  const view = rendered(detail({ supportingEvidence: [], archivedEvidenceCount: 0 }));
  expect(view.queryByRole("region", { name: "Supporting evidence" })).toBeNull();
});

it("describes absent Explain as waiting for seal without claiming sealed authority or blaming runtime", () => {
  const view = rendered(detail());
  const investigation = within(view.getByRole("region", { name: "AI investigation" }));
  expect(investigation.queryByText(/verdict already sealed/)).toBeNull();
  expect(investigation.queryByText(/Both views read the same sealed/)).toBeNull();
  expect(investigation.queryByText(/MODEL_RUNTIME_DISABLED/)).toBeNull();
  expect(investigation.getByText(/Waiting for seal.*Explain/i)).toBeTruthy();
});

it("retains sealed authority claims only when a verdict hash exists", () => {
  const view = rendered(detail({ verdictHash: "b".repeat(64), summary: { ...summary, sealed: true }, explanation: {
    text: "Structured findings", source: "fallback", rejection: null, modelId: null, runtimeReason: null, citations: [],
  } }));
  const investigation = within(view.getByRole("region", { name: "AI investigation" }));
  expect(investigation.getByText(/verdict already sealed/)).toBeTruthy();
  expect(investigation.getByText(/Both views read the same sealed/)).toBeTruthy();
  expect(view.queryByRole("button", { name: "Approve and co-sign" })).toBeNull();
});

it("shows submitted evidence ahead of ordinary inbox items even if the backend group is other", () => {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(createElement(InboxTable, { items: [
    { ...summary, eventId: "ordinary", state: "flagged", shortReason: "Ordinary review" }, summary,
  ] }));
  const view = within(root);
  expect(view.getByText("Evidence submitted")).toBeTruthy();
  const evidenceRow = view.getByText("Evidence submitted").closest("section");
  expect(evidenceRow?.getAttribute("data-inbox-group")).toBe("waiting");
  expect(view.queryByText("Ordinary review")).toBeNull();
});

it("retries a sealed approval audit from the detail panel while disabling other dispositions", async () => {
  const pending = detail({
    summary: { ...summary, state: "awaiting_cosignature", sealed: true },
    canApprove: true,
    approvalAuditPending: true,
  });
  const repaired = detail({
    summary: { ...summary, state: "resolved_approved", sealed: true },
    canApprove: false,
    approvalAuditPending: false,
  });
  const fetchMock = vi.fn((url: string) => Promise.resolve({
    ok: true,
    json: async () => url.endsWith("/actions") ? repaired : pending,
  }));
  vi.stubGlobal("fetch", fetchMock);
  const view = render(createElement(HandoffDetailView, { detail: pending }));

  const retry = view.getByRole("button", { name: "Retry approval audit" }) as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  expect(view.queryByRole("button", { name: "Approve and co-sign" })).toBeNull();
  for (const name of ["Request evidence", "Propose reroute", "Escalate", "Reject"]) {
    expect((view.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  }
  await waitFor(() => expect((view.getByRole("button", { name: "Refresh handoff" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(retry);
  expect(await view.findByText("Approved and sealed")).toBeTruthy();
  expect(fetchMock).toHaveBeenLastCalledWith("/api/operator/handoffs/event-1/actions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" }),
  });
  expect(view.queryByRole("button", { name: "Retry approval audit" })).toBeNull();
});

it("loads uploaded evidence over stale detail and supports refresh retry while keeping current evidence", async () => {
  const staleDetail = detail({ summary: { ...summary, state: "awaiting_evidence" }, supportingEvidence: [], canApprove: false });
  const updated = detail({ supportingEvidence: [rounds[0]] });
  const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
  const fetchMock = vi.fn().mockResolvedValueOnce(response(updated))
    .mockResolvedValueOnce(response({ error: "Detail temporarily unavailable" }, false)).mockResolvedValueOnce(response(detail()));
  vi.stubGlobal("fetch", fetchMock);
  const view = render(createElement(HandoffDetailView, { detail: staleDetail }));
  expect(await view.findByText("The recipient met me at the lobby.")).toBeTruthy();
  expect(view.getByText("Evidence submitted")).toBeTruthy();
  expect(view.queryByText("Round 2")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Refresh handoff" }));
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Detail temporarily unavailable"));
  expect(view.getByText("The recipient met me at the lobby.")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Refresh handoff" }));
  expect(await view.findByText("Round 2")).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock).toHaveBeenLastCalledWith("/api/operator/handoffs/event-1", { cache: "no-store" });
});

it.each(["success", "failure"])("does not overwrite a newer operator action when an older detail GET finishes with %s", async (outcome) => {
  let finish!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
  const sealed = detail({ summary: { ...summary, state: "resolved_approved", sealed: true }, canApprove: false, verdictHash: "c".repeat(64) });
  vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/actions")
    ? Promise.resolve({ ok: true, json: async () => sealed })
    : new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => { finish = resolve; })));
  const view = render(createElement(HandoffDetailView, { detail: detail() }));
  expect((view.getByRole("button", { name: "Refresh handoff" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "Approve and co-sign" }));
  expect(await view.findByText("Approved and sealed")).toBeTruthy();
  await act(async () => {
    finish({ ok: outcome === "success", json: async () => outcome === "success" ? detail() : { error: "Stale request failed" } });
  });
  await waitFor(() => expect((view.getByRole("button", { name: "Refresh handoff" }) as HTMLButtonElement).disabled).toBe(false));
  expect(view.getByText("Approved and sealed")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Approve and co-sign" })).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
});

import { afterEach, expect, it } from "vitest";
import { createMigratedDb } from "@/lib/db/migrate";
import { resolveRuntimeLlm } from "@/lib/llm/runtime";
import { createWorkbench, type OperatorWorkbench } from "./service";
import { POST as action } from "@/app/api/operator/handoffs/[eventId]/actions/route";
import { POST as upload } from "@/app/api/courier/evidence/[requestId]/route";

let wb: OperatorWorkbench | undefined;
afterEach(() => { wb?.close(); globalThis.__vigilOperatorWorkbench = undefined; });
async function setup() {
  wb = await createWorkbench({ scenarioIds: ["S1"], runtimeLlm: resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "none" }) });
  const sidecar = createMigratedDb(":memory:");
  wb.configureOnline({ store: sidecar, boundary: null });
  globalThis.__vigilOperatorWorkbench = Promise.resolve(wb);
  const eventId = wb.listQueue()[0].eventId;
  return { wb, eventId, sidecar, db: wb.debugHandle(eventId).db };
}
function requestAction(eventId: string, kind = "request_evidence", note = "Explain the scan.") {
  return action(new Request("http://localhost/api/operator/actions", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ action: kind, note }),
  }), { params: Promise.resolve({ eventId }) });
}
function requestUpload(requestId: string, courierId: string) {
  const form = new FormData();
  form.set("courierId", courierId); form.set("submissionId", "retry-receipt");
  form.set("explanation", "Supporting explanation.");
  form.append("files", new Blob(["%PDF-1.4\n<<>>\n%%EOF"], { type: "application/pdf" }), "receipt.pdf");
  return upload(new Request("http://localhost/api/courier/evidence", { method: "POST", body: form }),
    { params: Promise.resolve({ requestId }) });
}

it("repairs the case projection on an identical upload retry after a case write failure", async () => {
  const { wb, eventId, db, sidecar } = await setup();
  const requested = await wb.resolveHandoff(eventId, { action: "request_evidence", note: "Explain the scan." });
  const round = requested.supportingEvidence![0];
  db.$client.exec("CREATE TEMP TRIGGER fail_evidence_update BEFORE UPDATE OF state ON handoff_cases WHEN NEW.state = 'evidence_submitted' BEGIN SELECT RAISE(ABORT, 'case write failed'); END;");
  expect((await requestUpload(round.requestId, round.courierId)).status).toBe(422);
  db.$client.exec("DROP TRIGGER fail_evidence_update;");
  expect((await requestUpload(round.requestId, round.courierId)).status).toBe(200);
  expect(wb.getHandoff(eventId)!.summary.state).toBe("evidence_submitted");
  expect(wb.listQueue().some((item) => item.eventId === eventId)).toBe(true);
  expect(sidecar.$client.prepare("SELECT count(*) n FROM evidence_submissions").get()).toEqual({ n: 1 });
  expect(sidecar.$client.prepare("SELECT count(*) n FROM evidence_attachments").get()).toEqual({ n: 1 });
});

it("reconciles a durable reply on workspace refresh without asking the courier to re-upload files", async () => {
  const { wb, eventId, db, sidecar } = await setup();
  const requested = await wb.resolveHandoff(eventId, { action: "request_evidence", note: "Explain the scan." });
  const round = requested.supportingEvidence![0];
  db.$client.exec("CREATE TEMP TRIGGER fail_refresh BEFORE UPDATE OF state ON handoff_cases WHEN NEW.state = 'evidence_submitted' BEGIN SELECT RAISE(ABORT, 'case write failed'); END;");
  expect((await requestUpload(round.requestId, round.courierId)).status).toBe(422);
  db.$client.exec("DROP TRIGGER fail_refresh;");
  const refreshed = wb.courierWorkspace(round.courierId);
  expect(refreshed.evidenceRequests?.find((item) => item.request.requestId === round.requestId)?.state).toBe("evidence_submitted");
  expect(wb.listQueue().some((item) => item.eventId === eventId)).toBe(true);
  expect(sidecar.$client.prepare("SELECT count(*) n FROM evidence_submissions").get()).toEqual({ n: 1 });
});

it.each(["action_insert", "case_update"])("keeps a failed evidence request unpublished and repairs it exactly once after %s fails", async (failure) => {
  const { wb, eventId, db, sidecar } = await setup();
  const before = wb.getHandoff(eventId)!;
  const sql = failure === "action_insert"
    ? "CREATE TEMP TRIGGER fail_request BEFORE INSERT ON operator_actions BEGIN SELECT RAISE(ABORT, 'action write failed'); END;"
    : "CREATE TEMP TRIGGER fail_request BEFORE UPDATE OF state ON handoff_cases BEGIN SELECT RAISE(ABORT, 'case write failed'); END;";
  db.$client.exec(sql);
  expect((await requestAction(eventId)).status).toBe(409);
  db.$client.exec("DROP TRIGGER fail_request;");
  expect(wb.getHandoff(eventId)!.summary.state).toBe(before.summary.state);
  expect(wb.getHandoff(eventId)!.actions).toEqual(before.actions);
  expect(wb.getHandoff(eventId)!.supportingEvidence).toEqual([]);
  expect(wb.courierWorkspace("CR-1001").evidenceRequests).toEqual([]);
  expect((await requestAction(eventId, "request_evidence", "A different request")).status).toBe(409);
  expect((await requestAction(eventId, "reject", "Close instead")).status).toBe(409);
  expect((await requestAction(eventId)).status).toBe(200);
  expect(wb.getHandoff(eventId)!.summary.state).toBe("awaiting_evidence");
  expect(wb.getHandoff(eventId)!.supportingEvidence).toHaveLength(1);
  expect(db.$client.prepare("SELECT count(*) n FROM operator_actions").get()).toEqual({ n: 1 });
  expect(sidecar.$client.prepare("SELECT count(*) n FROM evidence_requests").get()).toEqual({ n: 1 });
  expect((await requestAction(eventId)).status).toBe(409);
});

it("repairs an approval audit write without sealing twice or allowing a different disposition", async () => {
  const { wb, eventId, db } = await setup();
  db.$client.exec("CREATE TEMP TRIGGER fail_approval BEFORE INSERT ON operator_actions BEGIN SELECT RAISE(ABORT, 'approval audit failed'); END;");
  expect((await requestAction(eventId, "approve", "Reviewed")).status).toBe(409);
  db.$client.exec("DROP TRIGGER fail_approval;");
  const sealed = wb.getHandoff(eventId)!;
  expect(sealed.summary.sealed).toBe(true);
  expect(sealed.canApprove).toBe(true);
  expect((await requestAction(eventId, "reject", "Different disposition")).status).toBe(409);
  const retried = await action(new Request("http://localhost/api/operator/actions", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve" }),
  }), { params: Promise.resolve({ eventId }) });
  expect(retried.status).toBe(200);
  const repaired = wb.getHandoff(eventId)!;
  expect(repaired.summary.state).toBe("resolved_approved");
  expect(repaired.ledger.sequence).toBe(sealed.ledger.sequence);
  expect(repaired.runs).toHaveLength(sealed.runs.length);
  expect(repaired.actions).toHaveLength(1);
  expect(repaired.actions[0].note).toBe("Reviewed");
  expect(db.$client.prepare("SELECT count(*) n FROM operator_actions").get()).toEqual({ n: 1 });
});

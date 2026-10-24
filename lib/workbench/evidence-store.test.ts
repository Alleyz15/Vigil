import { afterEach, describe, expect, it } from "vitest";
import { createMigratedDb } from "@/lib/db/migrate";
import { closeDb } from "@/lib/db/client";
import { evidenceAttachments, evidenceRequests, evidenceSubmissions } from "@/lib/db/schema";
import { EvidenceStore } from "./evidence-store";

const databases: ReturnType<typeof createMigratedDb>[] = [];
function setup() {
  const db = createMigratedDb(":memory:");
  databases.push(db);
  return new EvidenceStore(db);
}
afterEach(() => databases.splice(0).forEach(closeDb));
const base = { eventId: "event-1", workflowId: "workflow-1", courierId: "CR-1000", operatorId: "OP-01", note: "Explain the scan.", requestedAt: "2026-09-08T10:00:00+08:00", payloadHash: "a".repeat(64) };
const pdf = { name: "receipt.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4\n<<>>\n%%EOF") };

describe("supporting material is bounded and append-only", () => {
  it("rejects mismatched bytes, filenames, sizes and excessive files before storing a reply", () => {
    const store = setup();
    const round = store.request(base);
    for (const files of [
      [{ ...pdf, bytes: Buffer.from("<script>not a pdf</script>") }],
      [{ ...pdf, name: "../../receipt.pdf" }],
      [{ ...pdf, bytes: Buffer.alloc(5 * 1024 * 1024 + 1) }],
      [pdf, pdf, pdf, pdf],
      [{ ...pdf, mimeType: "image/png" }],
    ]) {
      expect(() => store.submit(round.requestId, { courierId: "CR-1000", submissionId: "s1", explanation: "Receipt", files }, base.requestedAt)).toThrow();
      expect(store.list("event-1")[0].submission).toBeNull();
    }
  });
  it("accepts a retry once, refuses conflicting content, and preserves earlier rounds", () => {
    const store = setup();
    const round = store.request(base);
    const reply = { courierId: "CR-1000", submissionId: "submission-1", explanation: "My supporting receipt.", files: [pdf] };
    store.submit(round.requestId, reply, base.requestedAt);
    store.submit(round.requestId, reply, base.requestedAt);
    expect(store.list(base.eventId)).toHaveLength(1);
    expect(store.list(base.eventId)[0].submission?.attachments).toHaveLength(1);
    expect(() => store.submit(round.requestId, { ...reply, explanation: "Changed" }, base.requestedAt)).toThrow(/different|conflict/i);
    store.request({ ...base, note: "Please clarify the receipt." });
    expect(store.list(base.eventId)).toHaveLength(2);
    expect(store.list(base.eventId)[0].submission?.explanation).toBe(reply.explanation);
    expect(() => store.request(base)).toThrow(/pending|outstanding/i);
  });
  it("refuses database updates and deletions of requests, replies and attachment bytes", () => {
    const db = createMigratedDb(":memory:"); databases.push(db);
    const store = new EvidenceStore(db);
    const round = store.request(base);
    store.submit(round.requestId, { courierId: "CR-1000", submissionId: "immutable", explanation: "Supporting material", files: [pdf] }, base.requestedAt);
    expect(() => db.update(evidenceRequests).set({ note: "Changed" }).run()).toThrow(/append-only/);
    expect(() => db.update(evidenceSubmissions).set({ explanation: "Changed" }).run()).toThrow(/append-only/);
    expect(() => db.update(evidenceAttachments).set({ bytes: Buffer.from("Changed") }).run()).toThrow(/append-only/);
    for (const table of [evidenceRequests, evidenceSubmissions, evidenceAttachments]) expect(() => db.delete(table).run()).toThrow(/append-only/);
  });
});

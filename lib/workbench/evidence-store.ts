import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { VigilDb } from "@/lib/db/client";
import { evidenceAttachments, evidenceRequests, evidenceSubmissions } from "@/lib/db/schema";
import { canonicalHash } from "@/lib/ledger";
import { EVIDENCE_MAX_FILES, EVIDENCE_MAX_FILE_BYTES, type EvidenceRequestView } from "./operations-types";

export type EvidenceFile = { name: string; mimeType: string; bytes: Buffer };
export type EvidenceReply = { courierId: string; submissionId: string; explanation: string; files: EvidenceFile[] };
type RequestInput = Omit<typeof evidenceRequests.$inferInsert, "requestId" | "sequence"> & { workflowId: string };

function checkedFile(file: EvidenceFile) {
  if (!file.name || file.name.length > 160 || /[\\/\x00-\x1f\x7f]/.test(file.name)) throw new Error("Invalid attachment filename.");
  if (!file.bytes.length || file.bytes.length > EVIDENCE_MAX_FILE_BYTES) throw new Error("Each attachment must be 1 byte to 5 MiB.");
  const extension = file.name.toLowerCase().split(".").at(-1);
  const png = file.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = file.bytes.length >= 4 && file.bytes[0] === 255 && file.bytes[1] === 216 && file.bytes[2] === 255
    && file.bytes.at(-2) === 255 && file.bytes.at(-1) === 217;
  const pdf = file.bytes.subarray(0, 5).toString("ascii") === "%PDF-" && file.bytes.subarray(-1024).toString("ascii").includes("%%EOF");
  if (!((file.mimeType === "image/png" && extension === "png" && png)
    || (file.mimeType === "image/jpeg" && ["jpg", "jpeg"].includes(extension ?? "") && jpeg)
    || (file.mimeType === "application/pdf" && extension === "pdf" && pdf))) {
    throw new Error("Only JPEG, PNG and PDF attachments with matching file contents are accepted.");
  }
  return { ...file, size: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex") };
}

export class EvidenceStore {
  constructor(private readonly db: VigilDb) {}

  list(eventId: string, workflowId?: string): EvidenceRequestView[] {
    return this.db.select().from(evidenceRequests).where(workflowId
      ? and(eq(evidenceRequests.eventId, eventId), eq(evidenceRequests.workflowId, workflowId))
      : eq(evidenceRequests.eventId, eventId)).orderBy(asc(evidenceRequests.sequence)).all().map((request) => {
      const submission = this.db.select().from(evidenceSubmissions).where(eq(evidenceSubmissions.requestId, request.requestId)).get();
      return {
        requestId: request.requestId, eventId, courierId: request.courierId, operatorId: request.operatorId,
        note: request.note, requestedAt: request.requestedAt,
        submission: submission ? {
          submissionId: submission.submissionId, explanation: submission.explanation, submittedAt: submission.submittedAt,
          attachments: this.db.select({ attachmentId: evidenceAttachments.attachmentId, name: evidenceAttachments.name,
            mimeType: evidenceAttachments.mimeType, size: evidenceAttachments.size, sha256: evidenceAttachments.sha256,
          }).from(evidenceAttachments).where(eq(evidenceAttachments.submissionId, submission.submissionId)).all(),
        } : null,
      };
    });
  }

  get(requestId: string) {
    const request = this.db.select().from(evidenceRequests).where(eq(evidenceRequests.requestId, requestId)).get();
    if (!request) throw new Error("No evidence request under that reference.");
    return request;
  }

  request(input: RequestInput): EvidenceRequestView {
    const note = z.string().trim().min(1, "Describe the evidence being requested.").max(500).parse(input.note);
    return this.db.transaction(() => {
      const previous = this.list(input.eventId, input.workflowId);
      if (previous.some((round) => !round.submission)) throw new Error("An outstanding evidence request is already pending.");
      const requestId = randomUUID();
      this.db.insert(evidenceRequests).values({ ...input, note, requestId, sequence: previous.length + 1 }).run();
      return this.list(input.eventId, input.workflowId).find((round) => round.requestId === requestId)!;
    });
  }

  submit(requestId: string, reply: EvidenceReply, submittedAt: string): { replayed: boolean } {
    const request = this.get(requestId);
    if (request.courierId !== reply.courierId) throw new Error("Only the assigned courier may submit this evidence.");
    const explanation = z.string().trim().min(1, "Explain the supporting evidence.").max(4000).parse(reply.explanation);
    z.string().min(1).max(100).parse(reply.submissionId);
    if (reply.files.length > EVIDENCE_MAX_FILES) throw new Error("At most three attachments may be submitted.");
    const files = reply.files.map(checkedFile);
    const requestHash = canonicalHash({ requestId, courierId: reply.courierId, explanation, files: files.map(({ name, mimeType, size, sha256 }) => ({ name, mimeType, size, sha256 })) });
    return this.db.transaction(() => {
      const existing = this.db.select().from(evidenceSubmissions).where(eq(evidenceSubmissions.requestId, requestId)).get();
      if (existing) {
        if (existing.submissionId === reply.submissionId && existing.requestHash === requestHash) return { replayed: true };
        throw new Error("Evidence was already submitted; conflicting or different content cannot replace it.");
      }
      this.db.insert(evidenceSubmissions).values({ submissionId: reply.submissionId, requestId, explanation, requestHash, submittedAt }).run();
      for (const file of files) {
        this.db.insert(evidenceAttachments).values({ ...file, attachmentId: randomUUID(), submissionId: reply.submissionId }).run();
      }
      return { replayed: false };
    });
  }

  attachment(attachmentId: string) {
    const file = this.db.select().from(evidenceAttachments).where(eq(evidenceAttachments.attachmentId, attachmentId)).get();
    if (!file) throw new Error("Attachment not found.");
    const submission = this.db.select().from(evidenceSubmissions).where(eq(evidenceSubmissions.submissionId, file.submissionId)).get()!;
    return { ...file, request: this.get(submission.requestId) };
  }
}

import { NextResponse } from "next/server";
import { getWorkbench } from "@/lib/workbench";
import { EVIDENCE_MAX_FILES, EVIDENCE_MAX_FILE_BYTES } from "@/lib/workbench/operations-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_BODY = EVIDENCE_MAX_FILES * EVIDENCE_MAX_FILE_BYTES + 64 * 1024;

/** Bound the stream itself: a missing or false Content-Length is not a size limit. */
async function boundedForm(request: Request): Promise<FormData> {
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data;")) throw new Error("Submit the evidence using the attachment form.");
  if (Number(request.headers.get("content-length")) > MAX_BODY) throw new Error("Evidence upload exceeds the size limit.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("No evidence was submitted.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error("Evidence upload exceeds the size limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers.get("content-type")! } }).formData();
}

export async function POST(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  try {
    const form = await boundedForm(request);
    const fields = ["courierId", "submissionId", "explanation", "files"];
    for (const key of form.keys()) if (!fields.includes(key)) throw new Error("Unexpected evidence form field.");
    for (const key of fields.slice(0, 3)) {
      if (form.getAll(key).length !== 1 || typeof form.get(key) !== "string") throw new Error(`Provide one ${key} value.`);
    }
    const files = form.getAll("files");
    if (files.length > EVIDENCE_MAX_FILES || files.some((file) => typeof file === "string" || file.size > EVIDENCE_MAX_FILE_BYTES)) throw new Error("Use at most three files, each no larger than 5 MiB.");
    const workspace = await (await getWorkbench()).submitEvidence((await params).requestId, {
      courierId: form.get("courierId") as string, submissionId: form.get("submissionId") as string,
      explanation: form.get("explanation") as string,
      files: await Promise.all((files as File[]).map(async (file) => ({ name: file.name, mimeType: file.type, bytes: Buffer.from(await file.arrayBuffer()) }))),
    });
    return NextResponse.json({ workspace });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 422 });
  }
}

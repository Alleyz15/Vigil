import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Demo actor scoping, not production authentication; bytes never live in public/. */
export async function GET(request: Request, { params }: { params: Promise<{ attachmentId: string }> }) {
  const query = new URL(request.url).searchParams;
  try {
    const file = (await getWorkbench()).evidenceAttachment((await params).attachmentId, {
      courierId: query.get("courierId") ?? undefined,
      role: query.get("role") === "operator" ? "operator" : undefined,
    });
    if (createHash("sha256").update(file.bytes).digest("hex") !== file.sha256) throw new Error("Attachment integrity check failed.");
    return new Response(new Uint8Array(file.bytes), { headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `attachment; filename="supporting-evidence.${file.mimeType === "application/pdf" ? "pdf" : file.mimeType === "image/png" ? "png" : "jpg"}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
      "Content-Length": String(file.size), "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  } catch {
    return NextResponse.json({ error: "Attachment unavailable for this demo actor, or failed its integrity check." }, { status: 404 });
  }
}

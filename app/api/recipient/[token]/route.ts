import { NextResponse } from "next/server";
import { z } from "zod";
import { RECIPIENT_ANSWERS } from "@/lib/recipient";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

/**
 * The recipient answers one question about one parcel.
 *
 * `no_response` is deliberately NOT accepted here. Silence is something the
 * system observes when a window closes, never something a caller asserts —
 * accepting it would let anyone holding the link record "they never replied"
 * on the recipient's behalf.
 */
const Answer = z.strictObject({ answer: z.enum(RECIPIENT_ANSWERS) });

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const workbench = await getWorkbench();
  return NextResponse.json(workbench.getConfirmation(token));
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const workbench = await getWorkbench();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = Answer.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid answer", issues: parsed.error.issues }, { status: 400 });
  }

  const result = workbench.answerConfirmation(token, parsed.data.answer);
  // A spent or unknown capability is a 409, not a 500: nothing went wrong, the
  // link simply cannot be used again.
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}

import { NextResponse } from "next/server";
import { OperatorActionRequest, getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const workbench = await getWorkbench();
  if (!workbench.getHandoff(eventId)) {
    return NextResponse.json({ error: "handoff not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const parsed = OperatorActionRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid operator action", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await workbench.resolveHandoff(eventId, parsed.data));
  } catch (error) {
    const message = (error as Error).message;
    if (/case is already resolved/i.test(message)) {
      return NextResponse.json(
        { error: message, code: "CASE_ALREADY_RESOLVED", detail: workbench.getHandoff(eventId) },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: message }, { status: 409 });
  }
}

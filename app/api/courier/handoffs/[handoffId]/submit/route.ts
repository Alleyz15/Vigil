import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

const CourierSubmission = z.strictObject({ signed: z.boolean() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ handoffId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = CourierSubmission.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid courier submission", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { handoffId } = await params;
  try {
    return NextResponse.json(await (await getWorkbench()).submitCourierHandoff(handoffId, parsed.data));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 404 });
  }
}

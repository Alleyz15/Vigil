import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

/**
 * `signed` is the ONLY thing the courier chooses.
 *
 * There is deliberately no field here for the decision, the risk level, or
 * anything else the engine owns. A courier submits evidence and a signature;
 * everything after that is computed. Accepting more from this body would be the
 * start of a client that can influence a verdict.
 */
const CourierSubmission = z.strictObject({ signed: z.boolean() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> },
) {
  const { draftId } = await params;
  const workbench = await getWorkbench();

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

  try {
    return NextResponse.json(await workbench.submitAsCourier(draftId, parsed.data));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 404 });
  }
}

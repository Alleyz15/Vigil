import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkbench } from "@/lib/workbench";
import { buildCosignPageState } from "@/lib/demo/cosign-state";

export const dynamic = "force-dynamic";

const CourierSubmission = z.strictObject({ signed: z.boolean(), courierId: z.string().min(1).optional() });

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
    const workbench = await getWorkbench();
    const result = await workbench.submitCourierHandoff(handoffId, parsed.data);
    return NextResponse.json({
      ...result,
      workspace: workbench.courierWorkspace(result.item.courierId),
      cosignState: buildCosignPageState(workbench, handoffId),
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 404 });
  }
}

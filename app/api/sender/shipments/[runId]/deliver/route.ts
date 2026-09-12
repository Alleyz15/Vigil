import { NextResponse } from "next/server";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

/**
 * The courier delivers.
 *
 * To the corrected address if there was a correction — the courier was told,
 * the registry was not. Nothing here informs the engine of either fact; the
 * delivery scan is submitted and the detectors compare it against what is on
 * file, exactly as they would for any other handoff.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const workbench = await getWorkbench();
  return NextResponse.json(await workbench.completeDelivery(runId));
}

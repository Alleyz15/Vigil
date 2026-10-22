import { NextResponse } from "next/server";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

/** Identity and work come from one read model, so the header cannot name a different courier. */
export async function GET() {
  const workbench = await getWorkbench();
  return NextResponse.json(workbench.courierWorkspace());
}

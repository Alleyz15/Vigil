import { NextResponse } from "next/server";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

/** Identity and work come from one read model, so the header cannot name a different courier. */
export async function GET(request: Request) {
  const workbench = await getWorkbench();
  try {
    return NextResponse.json(workbench.courierWorkspace(new URL(request.url).searchParams.get("courierId") ?? undefined));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 404 });
  }
}

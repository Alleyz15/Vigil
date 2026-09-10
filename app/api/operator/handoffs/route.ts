import { NextResponse } from "next/server";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export async function GET() {
  const workbench = await getWorkbench();
  return NextResponse.json(workbench.listHandoffs());
}


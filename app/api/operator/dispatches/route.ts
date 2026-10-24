import { NextResponse } from "next/server";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json((await getWorkbench()).dispatchWorkspace());
}

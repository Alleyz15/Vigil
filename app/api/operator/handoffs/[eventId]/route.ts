import { NextResponse } from "next/server";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const detail = (await getWorkbench()).getHandoff(eventId);
  if (!detail) return NextResponse.json({ error: "handoff not found" }, { status: 404 });
  return NextResponse.json(detail);
}


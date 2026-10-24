import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";
const Assignment = z.strictObject({ courierId: z.string().min(1).max(100) });
export async function POST(request: Request, { params }: { params: Promise<{ dispatchId: string }> }) {
  const parsed = Assignment.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Select a courier from the demo fleet." }, { status: 400 });
  try {
    return NextResponse.json(await (await getWorkbench()).assignDispatch((await params).dispatchId, parsed.data.courierId));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 409 });
  }
}

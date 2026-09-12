import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

/**
 * The sender corrects a recipient address after dispatch.
 *
 * ORDINARY BUSINESS. A customer moves, a unit number was wrong, a building has
 * two entrances. It is deliberately not part of the fault-injection surface:
 * correcting an address is something a merchant really does, and a GPS spoof is
 * not.
 */
const Correction = z.strictObject({ addressIndex: z.number().int().min(0) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = Correction.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid correction" }, { status: 400 });
  }

  const workbench = await getWorkbench();
  return NextResponse.json(workbench.correctAddress(runId, parsed.data.addressIndex));
}

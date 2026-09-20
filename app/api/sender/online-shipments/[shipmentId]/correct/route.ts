import { NextResponse } from "next/server";
import { getWorkbench } from "@/lib/workbench";
import { ConfirmedPoint } from "../../schema";

export const dynamic = "force-dynamic";

/**
 * Append a correction to the delivery reference. Ordinary business, as with the
 * cached-address correction: the original point is kept, and the engine is not
 * told.
 */
export async function POST(request: Request, { params }: { params: Promise<{ shipmentId: string }> }) {
  const { shipmentId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const parsed = ConfirmedPoint.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid point", issues: parsed.error.issues }, { status: 400 });

  const result = (await getWorkbench()).correctOnlineShipment(shipmentId, parsed.data);
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}

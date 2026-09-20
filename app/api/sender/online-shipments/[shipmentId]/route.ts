import { NextResponse } from "next/server";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

/** The stored shipment: its original reference, every correction, and whether this process runs it. */
export async function GET(_request: Request, { params }: { params: Promise<{ shipmentId: string }> }) {
  const { shipmentId } = await params;
  const shipment = (await getWorkbench()).onlineShipment(shipmentId);
  return shipment
    ? NextResponse.json(shipment)
    : NextResponse.json({ error: "no shipment under that reference" }, { status: 404 });
}

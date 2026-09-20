import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

/**
 * The SIMULATED courier scans the delivery.
 *
 * `simulatedScan` is where the simulated courier stands, and it is named for
 * what it is: a simulation input, never a reference. Omitted, the courier stands
 * at the current delivery reference.
 */
const Delivery = z.strictObject({
  simulatedScan: z
    .strictObject({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
    .optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ shipmentId: string }> }) {
  const { shipmentId } = await params;
  let body: unknown = {};
  const text = await request.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
    }
  }
  const parsed = Delivery.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid delivery", issues: parsed.error.issues }, { status: 400 });

  const result = await (await getWorkbench()).deliverOnlineShipment(shipmentId, parsed.data.simulatedScan);
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}

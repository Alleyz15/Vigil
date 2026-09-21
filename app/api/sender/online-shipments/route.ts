import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkbench } from "@/lib/workbench";
import { ConfirmedPoint, toLocationInput } from "./schema";

export const dynamic = "force-dynamic";

/**
 * Create a shipment from two confirmed points.
 *
 * `strictObject`, for the reason the other sender routes give: there is no field
 * for a decision, a risk level or a fault. A sender declares; everything after
 * is computed.
 *
 * THE IDEMPOTENCY KEY IS REQUIRED, in the `Idempotency-Key` header. Without one,
 * a retry on a flaky connection would create a second parcel, and the server
 * cannot tell a retry from a new shipment by comparing bodies — two parcels to
 * one door are two parcels.
 */
const Request = z.strictObject({
  origin: ConfirmedPoint,
  destination: ConfirmedPoint,
  declaredValueSen: z.number().int().positive(),
  codAmountSen: z.number().int().nonnegative().optional(),
  recipientChannel: z.string().min(3),
  recipientName: z.string().min(1).optional(),
});

const STATUS = { created: 201, replayed: 200, conflict: 409, rejected: 422 } as const;

export async function POST(request: globalThis.Request) {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || key.length > 200) {
    return NextResponse.json({ error: "an Idempotency-Key header of 1-200 characters is required" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const parsed = Request.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid shipment", issues: parsed.error.issues }, { status: 400 });
  }

  // Both ends are verified before anything is written, as the boundary check is.
  const origin = await toLocationInput(parsed.data.origin);
  if (!origin.ok) return NextResponse.json({ status: "rejected", field: "origin", code: "unverified_address", reason: origin.reason }, { status: 422 });
  const destination = await toLocationInput(parsed.data.destination);
  if (!destination.ok) {
    return NextResponse.json({ status: "rejected", field: "destination", code: "unverified_address", reason: destination.reason }, { status: 422 });
  }

  const workbench = await getWorkbench();
  const result = await workbench.createOnlineShipment(
    { ...parsed.data, origin: origin.location, destination: destination.location },
    key,
  );
  return NextResponse.json(result, { status: STATUS[result.status] });
}

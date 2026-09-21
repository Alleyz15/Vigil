import { NextResponse } from "next/server";
import { z } from "zod";
import { failureMessage, geocoder, GEOCODE_ATTRIBUTION } from "@/lib/geocode";
import { roundCoordinate } from "@/lib/shipment";

export const dynamic = "force-dynamic";

/**
 * Reverse lookup: a clicked coordinate in, an address LABEL out.
 *
 * THE PIN DOES NOT MOVE. The answer carries the label and the OSM object it
 * came from, and hands back the queried coordinate unchanged under `at`; it has
 * no field for the found object's own position, so there is nothing a page
 * could mistakenly move the pin to.
 *
 * The coordinate must already be the picker's six-decimal value — the value
 * shown and stored. A longer one is refused rather than rounded here, because
 * rounding in this route would make the looked-up point differ from the point
 * the page holds.
 */
const Body = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "a latitude and longitude are required" }, { status: 400 });
  const point = parsed.data;
  if (roundCoordinate(point.latitude) !== point.latitude || roundCoordinate(point.longitude) !== point.longitude) {
    return NextResponse.json({ error: "the coordinate must be the confirmed six-decimal value" }, { status: 400 });
  }

  const result = await geocoder().reverse(point);
  if (result.status === "failed") {
    return NextResponse.json({
      status: "failed",
      at: point,
      reason: result.reason,
      message: failureMessage(result.reason, "reverse"),
      detail: result.detail,
      attribution: GEOCODE_ATTRIBUTION,
    });
  }
  return NextResponse.json({
    status: "found",
    source: result.source,
    at: result.at,
    label: result.found.label,
    ref: result.found.ref,
    attribution: GEOCODE_ATTRIBUTION,
  });
}

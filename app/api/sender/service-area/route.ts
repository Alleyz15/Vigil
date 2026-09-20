import { NextResponse } from "next/server";
import { boundaryLabel, boundaryStamp, loadServiceBoundary, outsideMessage, serviceAreaSentence } from "@/lib/shipment";

export const dynamic = "force-dynamic";

/**
 * The service area, so the picker can DRAW it.
 *
 * A person should see the shape before they click, not discover it by being
 * refused — a boundary you can only find by hitting it is a disabled button
 * with extra steps. So the geometry is served, with the credit and the
 * extraction date beside it, and the map prints both.
 *
 * READ-ONLY, AND LOCAL. It reads the file `scripts/fetch-kl-boundary.mjs`
 * committed; nothing here fetches a boundary, geocodes anything, or sends a
 * coordinate anywhere.
 *
 * The browser drawing this polygon is a COURTESY: `createShipment` checks every
 * point against the same boundary server-side, and that check is the one that
 * decides.
 */
export function GET() {
  const boundary = loadServiceBoundary();
  const stamp = boundaryStamp(boundary);
  return NextResponse.json({
    version: boundary.version,
    source: boundary.source,
    licence: boundary.licence,
    placeholder: Boolean(boundary.placeholder),
    members: boundary.members ?? [],
    sentence: serviceAreaSentence(boundary),
    outsideMessage: outsideMessage(boundary),
    label: boundaryLabel(boundary),
    credit: stamp.credit,
    extracted: stamp.extracted,
    showExtracted: stamp.showExtracted,
    area: boundary.area,
  });
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { failureMessage, geocoder, looksLikePhoneNumber, PHONE_REFUSAL, GEOCODE_ATTRIBUTION } from "@/lib/geocode";
import { checkPoint, loadServiceBoundary, outsideMessage } from "@/lib/shipment";

export const dynamic = "force-dynamic";

/**
 * Forward search: address text in, candidates out. SERVER-SIDE ONLY — the
 * browser never talks to Nominatim, so the User-Agent, the one-per-second queue
 * and the cache cannot be bypassed from a page.
 *
 * THE BODY HOLDS ONE FIELD. `strictObject` refuses anything else, so a name, a
 * phone number or a shipment id cannot ride along to the geocoder even by a
 * client's mistake. A query that is only a phone number is refused before any
 * request exists.
 *
 * EVERY CANDIDATE IS CHECKED AGAINST THE SERVICE AREA HERE, with the same
 * boundary the create route uses. One outside it comes back with the reason and
 * the four covered units — and `selectable: false` — rather than being dropped
 * silently or greyed out without a word.
 */
const Body = z.strictObject({ query: z.string().trim().min(3).max(200) });

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Type at least three characters of an address to search for." }, { status: 400 });
  }
  if (looksLikePhoneNumber(parsed.data.query)) {
    return NextResponse.json({ error: PHONE_REFUSAL, code: "not_an_address" }, { status: 400 });
  }

  const result = await geocoder().search({ q: parsed.data.query });
  if (result.status === "failed") {
    return NextResponse.json({
      status: "failed",
      reason: result.reason,
      message: failureMessage(result.reason, "search"),
      detail: result.detail,
      attribution: GEOCODE_ATTRIBUTION,
    });
  }

  const boundary = loadServiceBoundary();
  const outside = outsideMessage(boundary);
  return NextResponse.json({
    status: "found",
    source: result.source,
    query: parsed.data.query,
    attribution: GEOCODE_ATTRIBUTION,
    candidates: result.candidates.map((candidate) => {
      const check = checkPoint(candidate, boundary);
      return check.ok
        ? { ...candidate, selectable: true as const }
        : { ...candidate, selectable: false as const, refusal: outside };
    }),
  });
}

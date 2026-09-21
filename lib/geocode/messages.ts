import type { FailureReason } from "./types";

/**
 * What the geocoding surfaces SAY, derived here rather than typed per component.
 * Pure and dependency-free, so the browser can import it without pulling the
 * adapter's `node:fs` along.
 */

/**
 * The credit shown beside every result. A LOCAL constant, not the `licence`
 * string Nominatim returns: provider prose does not cross the boundary (rule
 * 1e), even when it is only a licence line.
 */
export const GEOCODE_ATTRIBUTION = "Address data © OpenStreetMap contributors, ODbL 1.0 · via Nominatim";

/**
 * One normal form, used as the cache key AND as the text actually sent — so a
 * cached answer is exactly the answer to the request that would have gone out.
 * Case and runs of whitespace do not change what Nominatim finds.
 */
export function normaliseQuery(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * THE DATA BOUNDARY, CHECKED WHERE A PERSON CAN SEE IT. Only address text may
 * be sent. A query that is nothing but a phone number is refused before any
 * request exists, with the reason, rather than forwarded to a third party
 * because it happened to be typed into the address box.
 */
export function looksLikePhoneNumber(raw: string): boolean {
  const compact = raw.replace(/[\s().-]/g, "");
  return /^\+?\d{7,15}$/.test(compact);
}

export const PHONE_REFUSAL =
  "That looks like a phone number, not an address. Only address text is sent to the geocoder — " +
  "the recipient's number goes in its own field and never leaves this system.";

/**
 * SIX REASONS, SIX SENTENCES. Each names what happened and what the person
 * can do next; none of them offers a substitute address, coordinate or result.
 */
export function failureMessage(reason: FailureReason, kind: "search" | "reverse"): string {
  switch (reason) {
    case "unreachable":
      return "The geocoder could not be reached, so nothing was looked up. You can still click the map and confirm the point yourself.";
    case "timeout":
      return "The geocoder did not answer in time, so nothing was looked up. Try again in a moment, or click the map.";
    case "rate_limited":
      return "Too many lookups at once — the public geocoder allows one request per second for this whole application. Wait a few seconds and try again.";
    case "refused":
      return "The geocoder refused the request, so nothing was looked up. Click the map to confirm a point without it.";
    case "no_results":
      return kind === "search"
        ? "No place matched that text. Try a street, a building or a postcode, or click the map."
        : "Address not resolved — the geocoder has no address at this point. The coordinate is unchanged and can still be confirmed.";
    case "malformed":
      return "The geocoder answered with something that could not be read, so it was not used.";
  }
}

import type { ServiceBoundary } from "./boundary";

/**
 * WHAT THE MAP PICKER SAYS, derived rather than retyped.
 *
 * Pure, and deliberately in `lib/shipment` rather than in the component: the
 * API route and the browser both read it, and two copies of a sentence about
 * coverage is exactly how a label starts over-claiming.
 *
 * NOTHING HERE GEOCODES. There is no address resolution in this phase, so a
 * point a person confirmed has a coordinate and, if they typed one, a claim —
 * never a resolved address the system worked out for them.
 */

/**
 * The precision a confirmed coordinate is kept at: 6 decimal places, about
 * 11 cm at this latitude.
 *
 * THE ROUNDING HAPPENS AT THE CLICK, NOT AT THE DISPLAY. A map click yields a
 * double with fifteen digits; showing six of them while storing all fifteen
 * would mean the number on screen is not the number confirmed. So the click is
 * rounded once, and the rounded value is what is shown, stored, sent and used
 * as the delivery reference. This is the only quantisation applied to a
 * confirmed point — there is no snapping to a road, a building or an address.
 */
export const COORDINATE_DECIMALS = 6;

export function roundCoordinate(value: number): number {
  return Number(value.toFixed(COORDINATE_DECIMALS));
}

export function formatCoordinate(value: number): string {
  return value.toFixed(COORDINATE_DECIMALS);
}

/** The value confirmed, in the form it is stored and sent. */
export function confirmPoint(latitude: number, longitude: number): { latitude: number; longitude: number } {
  return { latitude: roundCoordinate(latitude), longitude: roundCoordinate(longitude) };
}

/**
 * A member's short name: what comes before its qualifier.
 *
 *   "Kuala Lumpur (Federal Territory)" -> "Kuala Lumpur"
 *   "Petaling, Selangor"               -> "Petaling"
 *
 * A label with neither is returned whole, so an unexpected shape shows the full
 * name rather than a guess at a shorter one.
 */
export function shortMemberName(label: string): string {
  return label.split(/\s*[(,]/)[0].trim() || label;
}

/**
 * THE SERVICE AREA IS NAMED BY LISTING ITS MEMBERS, and the list comes from the
 * boundary. A future session that adds a district gets a longer sentence for
 * free; one that writes "Klang Valley" here would be claiming Klang and Gombak,
 * where this project has no address and no depot.
 */
export function serviceAreaSentence(boundary: Pick<ServiceBoundary, "members" | "placeholder">): string {
  if (!boundary.members || boundary.members.length === 0) {
    return "Service area: a placeholder radius around the depots — boundary data pending confirmation";
  }
  return `Service area: ${boundary.members.map(shortMemberName).join(", ")}`;
}

/**
 * Why a point was refused, in the words a person can act on.
 *
 * NOT A DISABLED BUTTON. A control that greys out states that something is
 * impossible and never says why; here the reason is the coverage itself, and
 * naming the four units is what tells someone whether to move the pin or give
 * up (rule 3g: a correct message that does not say what to do next has not done
 * its job).
 */
export function outsideMessage(boundary: Pick<ServiceBoundary, "members" | "placeholder">): string {
  if (boundary.placeholder) {
    return (
      "That point is outside the placeholder service radius around the depots. Boundary data is " +
      "pending confirmation, so this is not a statement about where any city ends."
    );
  }
  const members = (boundary.members ?? []).map(shortMemberName);
  const listed =
    members.length > 1 ? `${members.slice(0, -1).join(", ")} and ${members.at(-1)}` : members.join("");
  return (
    `That point is outside the service area. Vigil covers ${listed} — the administrative units this ` +
    "network has addresses and depots in, and nothing beyond them. Choose a point inside the outlined " +
    "area; the server checks the same boundary and would refuse this one."
  );
}

/**
 * The boundary's own credit and date, for the corner of the map.
 *
 * ODbL requires the credit wherever the data is used, so it rides with the
 * geometry (`boundary.attribution`) and this only decides where the line breaks.
 */
export function boundaryStamp(
  boundary: Pick<ServiceBoundary, "attribution" | "extractedAt" | "version" | "placeholder">,
): { credit: string; extracted: string | null; showExtracted: boolean } {
  const credit = boundary.attribution ?? boundary.version;
  const extracted = boundary.extractedAt ? boundary.extractedAt.slice(0, 10) : null;
  return {
    credit,
    extracted,
    // The ODbL line this project's extractor writes already ends with the date,
    // so a second copy of it under the first is noise rather than provenance.
    // Derived from the strings rather than left to whoever edits the component.
    showExtracted: extracted !== null && !credit.includes(extracted),
  };
}

/** The heading over a geocoder's label. Names the provider, so the line cannot pass for the sender's. */
export const RESOLVED_HEADING = "Resolved by OpenStreetMap Nominatim";
/** The heading over the sender's own text. */
export const CLAIM_HEADING = "The sender's own words";

export type AddressLines = {
  /** What the geocoder said, or null where nothing was resolved. */
  resolved: { heading: string; label: string; by: "search" | "reverse" } | null;
  /** What the sender typed, or null. */
  claim: { heading: string; text: string } | null;
  /** The sentence shown when the geocoder resolved nothing. Null when it did. */
  unresolved: string | null;
};

/**
 * What a point's address says — as TWO LINES FROM TWO SOURCES, never one.
 *
 * The geocoder's label and the sender's words are kept apart in the store, and
 * they are kept apart here too: each carries its own heading, so a screen that
 * renders this cannot print a provider's text as the sender's claim or the
 * sender's text as a resolved address. Separate columns shown as one line would
 * undo the separation at the last step.
 *
 * AN UNRESOLVED ADDRESS IS A FACT, NOT A BLANK FIELD (rule 4f). Where the
 * geocoder found nothing the line says so; nothing is guessed in its place —
 * a plausible street invented for an arbitrary click is rule 3e's fabrication
 * in a different carrier.
 */
export function addressLines(input: {
  claim: string | null;
  resolved: { label: string; by: "search" | "reverse" } | null;
}): AddressLines {
  const claim = input.claim ? { heading: CLAIM_HEADING, text: input.claim } : null;
  if (input.resolved) {
    return { resolved: { heading: RESOLVED_HEADING, ...input.resolved }, claim, unresolved: null };
  }
  return {
    resolved: null,
    claim,
    unresolved: claim
      ? "Address not resolved — the line above is the sender's own description, not a lookup"
      : "Address not resolved — no address is guessed",
  };
}

/** A typed claim, trimmed; nothing is a claim. */
export function normaliseClaim(input: string): string | null {
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

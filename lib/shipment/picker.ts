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

/**
 * What a point's address line says.
 *
 * AN EMPTY ADDRESS IS A FACT, NOT A BLANK FIELD. No geocoder ran, so nothing
 * resolved this coordinate to a street; saying so is a stronger statement than
 * an empty box, and inventing a plausible address for an arbitrary click would
 * be the fabrication rule 3e bans in a different carrier (rule 4f: the absence
 * is the observation).
 */
export function addressLine(claim: string | null): { resolved: false; text: string; claim: string | null } {
  return {
    resolved: false,
    text: claim
      ? "Address not resolved — this is the sender's own description of the point"
      : "Address not resolved — no geocoder was called, and none is guessed",
    claim,
  };
}

/** A typed claim, trimmed; nothing is a claim. */
export function normaliseClaim(input: string): string | null {
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

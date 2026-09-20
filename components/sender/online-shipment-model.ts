import type { Feature, MultiPolygon, Polygon } from "geojson";

/**
 * The picker's own types and the few pure decisions it makes.
 *
 * The SENTENCES all come from `lib/shipment/picker` — the service-area name,
 * the refusal reason and the attribution are derived from the boundary, not
 * written here. What is left is what this surface decides: whether a point may
 * be confirmed, and what the two slots say when they are empty.
 */

/** The service area as the browser receives it. Mirrors `/api/sender/service-area`. */
export type ServiceAreaView = {
  version: string;
  source: string;
  licence: string;
  placeholder: boolean;
  members: string[];
  /** "Service area: Kuala Lumpur, Petaling, Hulu Langat, Sepang" — built from `members`. */
  sentence: string;
  /** Why an outside point is refused, naming the members. Derived server-side. */
  outsideMessage: string;
  label: string;
  /** The ODbL credit, which travels with the geometry. */
  credit: string;
  /** The extraction date, `YYYY-MM-DD`, or null for the placeholder. */
  extracted: string | null;
  /** False when `credit` already ends with that date, so it is not said twice. */
  showExtracted: boolean;
  area: Feature<Polygon | MultiPolygon>;
};

/**
 * A point the person has clicked. `inside` is the BROWSER's courtesy check;
 * the server re-checks every point against the same boundary and its answer is
 * the one that decides.
 */
export type PickedPoint = {
  latitude: number;
  longitude: number;
  inside: boolean;
  /** What the sender typed for it, or null: no geocoder resolved anything. */
  claim: string | null;
};

export type SlotName = "origin" | "destination";

export const SLOT_LABEL: Record<SlotName, string> = {
  origin: "Collection point",
  destination: "Delivery point",
};

/**
 * Whether the pending point may be confirmed into a slot.
 *
 * An outside point is NOT confirmable, and the surface says why in words rather
 * than greying a control: see `outsideMessage`. A missing address claim is no
 * obstacle at all — there is no geocoder, so an unresolved point is the normal
 * case, not an incomplete form.
 */
export function canConfirm(pending: PickedPoint | null): boolean {
  return pending !== null && pending.inside;
}

/**
 * Whether the two confirmed points can be sent.
 *
 * The same coordinate at both ends is refused here for the reason the cached
 * form refuses one address twice: a shipment from a door to that same door is
 * not a shipment, and the depot router would call it local and be right.
 */
export function submitRefusal(
  origin: PickedPoint | null,
  destination: PickedPoint | null,
  declaredValueSen: number,
  channel: string,
): string | null {
  if (!origin) return "Confirm a collection point on the map.";
  if (!destination) return "Confirm a delivery point on the map.";
  if (origin.latitude === destination.latitude && origin.longitude === destination.longitude) {
    return "Collection and delivery are the same coordinate. Confirm two different points.";
  }
  if (!Number.isSafeInteger(declaredValueSen) || declaredValueSen <= 0) {
    return "Declare a parcel value above zero.";
  }
  if (channel.trim().length < 3) return "The recipient's number is required: I15 verifies it independently.";
  return null;
}

/**
 * A fresh idempotency key per attempt at a NEW shipment, reused across retries
 * of the same one.
 *
 * Two points a person confirmed at one address are two parcels, so the key is
 * not derived from the coordinates — it is minted once when the form is filled
 * and kept until a shipment is actually created. A retry after a dropped
 * connection carries the same key and returns the same parcel; pressing the
 * button again after a success gets a new one.
 */
export function newIdempotencyKey(random: () => string): string {
  return `sender-online-${random()}`;
}

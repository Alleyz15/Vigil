import { z } from "zod";
import { cachedGeocoder, Resolution, verifyResolution } from "@/lib/geocode";
import type { LocationInput } from "@/lib/shipment";

/**
 * A point a person confirmed on a map, the address text they typed for it, and
 * — since phase two — which geocoder lookup, if any, described it.
 *
 * THE COORDINATE IS THE CLAIM. The typed text is stored verbatim and never
 * parsed. A resolved label is not sent as text at all: `resolution` names the
 * lookup it came from, and the server reads the label back out of the geocode
 * cache with the network forbidden (`verifyResolution`). A label nobody's
 * lookup produced cannot be recorded as resolved.
 *
 * THE CLAIM IS OPTIONAL, and so is the resolution: an unresolved point is the
 * honest state of an arbitrary click, not an incomplete form.
 */
export const ConfirmedPoint = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  addressClaim: z.string().max(200).optional(),
  resolution: Resolution.optional(),
});
export type ConfirmedPoint = z.infer<typeof ConfirmedPoint>;

/**
 * The confirmed point as the store takes it. A resolution that cannot be
 * verified REFUSES the request rather than dropping the label silently: the
 * person was shown an address, and storing the point without it — while saying
 * nothing — would record something other than what they confirmed.
 */
export async function toLocationInput(
  point: ConfirmedPoint,
): Promise<{ ok: true; location: LocationInput } | { ok: false; reason: string }> {
  const location: LocationInput = {
    latitude: point.latitude,
    longitude: point.longitude,
    ...(point.addressClaim !== undefined ? { addressClaim: point.addressClaim } : {}),
  };
  if (!point.resolution) return { ok: true, location };
  const verified = await verifyResolution(point, point.resolution, cachedGeocoder());
  return verified.ok ? { ok: true, location: { ...location, resolved: verified.resolved } } : verified;
}

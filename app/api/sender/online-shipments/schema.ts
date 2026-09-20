import { z } from "zod";

/**
 * A point a person confirmed on a map, and the address text they typed for it.
 *
 * The coordinate is the claim; the text is stored verbatim and never parsed.
 * Nothing here geocodes: this phase has no geocoder and sends nothing to one.
 */
export const ConfirmedPoint = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  addressClaim: z.string().trim().min(1).max(200),
});

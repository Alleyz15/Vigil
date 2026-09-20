import { z } from "zod";

/**
 * A point a person confirmed on a map, and the address text they typed for it.
 *
 * The coordinate is the claim; the text is stored verbatim and never parsed.
 * Nothing here geocodes: this phase has no geocoder and sends nothing to one.
 *
 * THE CLAIM IS OPTIONAL. There is no geocoder, so a confirmed point has no
 * resolved address — requiring one before a shipment may be created would make
 * an empty box look like a lookup that had failed, and would push a sender into
 * typing something so the form would submit. Absent means absent; the surfaces
 * say "address not resolved" rather than leaving a gap.
 */
export const ConfirmedPoint = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  addressClaim: z.string().max(200).optional(),
});

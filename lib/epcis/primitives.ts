import { z } from "zod";

/**
 * Scalar building blocks for GS1 EPCIS 2.0, hand-transcribed from the spec.
 * There is no usable EPCIS npm package, so these zod schemas are both the
 * runtime validators and the written documentation of our synthetic data.
 */

/**
 * EPC in pure-identity URI form, e.g. `urn:epc:id:sgtin:0614141.107346.2017`.
 * Kept deliberately loose on the body: we validate shape, not GS1 company
 * prefix allocation, which we have no authority to check.
 */
export const EpcUri = z
  .string()
  .regex(
    /^urn:epc:id:[a-z0-9]+:[\x21-\x7e]+$/,
    "must be a pure-identity EPC URI, e.g. urn:epc:id:sgtin:0614141.107346.2017",
  )
  .brand<"EpcUri">();
export type EpcUri = z.infer<typeof EpcUri>;

/**
 * Location identifier: SGLN URI for a physical place.
 * `readPoint` and `bizLocation` both use this.
 */
export const LocationUri = z
  .string()
  .regex(
    /^urn:epc:id:sgln:[\x21-\x7e]+$/,
    "must be an SGLN URI, e.g. urn:epc:id:sgln:0614141.00777.0",
  )
  .brand<"LocationUri">();
export type LocationUri = z.infer<typeof LocationUri>;

/**
 * ISO-8601 instant that MUST carry an explicit UTC offset.
 *
 * This is not pedantry. Half of our tampering detectors compare `eventTime`
 * (device clock) against `recordTime` (server clock). A timestamp without an
 * offset is unanchored and silently defeats I4/I5, so we reject it at the
 * schema boundary rather than guessing a timezone downstream.
 */
export const Iso8601WithOffset = z
  .string()
  .refine(
    (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v),
    "must be ISO-8601 with an explicit UTC offset or trailing Z",
  )
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be a parsable instant");
export type Iso8601WithOffset = z.infer<typeof Iso8601WithOffset>;

/**
 * EPCIS carries the device's local UTC offset separately from `eventTime`
 * so the original wall-clock reading is recoverable. Range covers -12:00..+14:00.
 */
export const UtcOffset = z
  .string()
  .regex(/^[+-]\d{2}:\d{2}$/, "must look like +08:00")
  .refine((v) => {
    const [h, m] = v.slice(1).split(":").map(Number);
    const mins = h * 60 + m;
    return m < 60 && (v[0] === "-" ? mins <= 720 : mins <= 840);
  }, "offset out of the -12:00..+14:00 range");
export type UtcOffset = z.infer<typeof UtcOffset>;

/**
 * EPCIS 2.0 gives every event a UUID `eventID`. We reuse it directly as the
 * replay nonce — see lib/ledger. No separate nonce field is needed or wanted:
 * a second nonce would be a second thing an attacker could vary independently.
 */
export const EventId = z.uuid().brand<"EventId">();
export type EventId = z.infer<typeof EventId>;

/** WGS-84 coordinate pair. Latitude first, matching @turf/turf's [lng, lat] inverse. */
export const GeoPoint = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Reported horizontal accuracy in metres, if the device supplied one. */
  accuracyMeters: z.number().nonnegative().optional(),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

import { z } from "zod";
import { BizStep } from "@/lib/epcis";

/**
 * CourierMandate — an authorisation OBJECT, not a permissions row.
 *
 * SCOPE OF THIS FILE: the shape only. No key handling, no signing, no
 * verification. The Ed25519 co-sign lands in a later session; H2, H3 and I13
 * need to read a mandate now, and that is all this provides.
 *
 * The distinction that matters later: `requiresCosignIf` does not mark a handoff
 * for review. It determines whether a courier-signed token alone can ever
 * verify. Approval is constitutive — see CLAUDE.md.
 */

/** What the courier is allowed to touch. */
export const MandateScope = z.strictObject({
  /**
   * EPC URI prefixes this courier may scan. Prefix matching, not exact: a route
   * is assigned as a range of parcels, not a list.
   */
  epcPrefixes: z.array(z.string().min(1)),
  /** SGLN URIs the courier may operate at. Empty means unrestricted by location. */
  bizLocations: z.array(z.string().min(1)),
  /** Which business steps this courier may perform. Empty means unrestricted. */
  bizSteps: z.array(BizStep),
});
export type MandateScope = z.infer<typeof MandateScope>;

/** Hard ceilings. These are stops, not warnings: a co-sign does not lift them. */
export const MandateLimits = z.strictObject({
  maxHandoffsPerShift: z.number().int().positive(),
  /** Cash-on-delivery ceiling, in sen. */
  codCashCapSen: z.number().int().nonnegative(),
  /** Declared-value ceiling for a single parcel, in sen. */
  maxParcelValueSen: z.number().int().nonnegative(),
});
export type MandateLimits = z.infer<typeof MandateLimits>;

/** A permitted working window, in the mandate's local time. */
export const TimeWindow = z.strictObject({
  /** Inclusive start, "HH:MM" in 24-hour local time. */
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be "HH:MM"'),
  /** Exclusive end. May be earlier than start, meaning the window crosses midnight. */
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be "HH:MM"'),
});
export type TimeWindow = z.infer<typeof TimeWindow>;

export const MandateValidity = z.strictObject({
  notBefore: z.iso.datetime({ offset: true }),
  notAfter: z.iso.datetime({ offset: true }),
  /** Permitted hours within the validity period. Empty means any hour. */
  timeWindows: z.array(TimeWindow),
});
export type MandateValidity = z.infer<typeof MandateValidity>;

/** A condition that forces operator co-signature. */
export const CosignCondition = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("parcel_value_over_sen"), value: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("recipient_address_not_in_scope") }),
  z.strictObject({ kind: z.literal("inconsistency_score_at_least"), value: z.number().min(0).max(100) }),
  z.strictObject({ kind: z.literal("pattern_score_at_least"), value: z.number().min(0).max(100) }),
]);
export type CosignCondition = z.infer<typeof CosignCondition>;

export const CourierMandate = z.strictObject({
  mandateId: z.string().min(1),
  courierId: z.string().min(1),
  /**
   * Neither preset disables the deterministic engine or pattern monitoring.
   * "trusted" widens scope and raises limits; it never turns a check off.
   */
  preset: z.enum(["standard", "trusted"]),
  scope: MandateScope,
  limits: MandateLimits,
  validity: MandateValidity,
  requiresCosignIf: z.array(CosignCondition),
  /** Enforced quiet period after a high-risk handoff, in seconds. */
  cooldownSeconds: z.number().int().nonnegative(),
  status: z.enum(["active", "paused", "revoked"]),
  nonceCounter: z.number().int().nonnegative(),
});
export type CourierMandate = z.infer<typeof CourierMandate>;

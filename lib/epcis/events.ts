import { z } from "zod";
import {
  EpcUri,
  EventId,
  Iso8601WithOffset,
  LocationUri,
  UtcOffset,
} from "./primitives";
import { Action, BizStep, BizTransaction, Disposition, PartyId } from "./vocabulary";
import { SensorElement } from "./sensor";

/**
 * GS1 EPCIS 2.0 events across the five dimensions:
 *
 *   what   epcList
 *   when   eventTime / recordTime / eventTimeZoneOffset
 *   where  readPoint / bizLocation
 *   why    bizStep / disposition / bizTransactionList
 *   how    sensorElementList  (incl. the vigil: extension — see ./sensor.ts)
 */

/** Fields shared by every event type. */
const EventBase = {
  /** EPCIS 2.0 supplies a UUID here. We reuse it as the replay nonce. */
  eventID: EventId,

  /**
   * WHEN, part 1: the device's claim about when this happened.
   * Attacker-controlled. Never trusted alone.
   */
  eventTime: Iso8601WithOffset,

  /**
   * WHEN, part 2: when the server actually received it.
   *
   * eventTime vs recordTime divergence is a free tampering detector and the
   * reason both are modelled explicitly rather than collapsed into one field.
   * Optional at the schema level because the device does not author it — the
   * ingest boundary stamps it. An event that arrives WITH a recordTime already
   * set is itself suspicious, and the engine treats it as such.
   */
  recordTime: Iso8601WithOffset.optional(),

  /** WHEN, part 3: the device's local UTC offset, preserved separately per spec. */
  eventTimeZoneOffset: UtcOffset,

  /** WHERE: the precise point of capture, and the wider business location. */
  readPoint: z.strictObject({ id: LocationUri }).optional(),
  bizLocation: z.strictObject({ id: LocationUri }).optional(),

  /** WHY. */
  bizStep: BizStep.optional(),
  disposition: Disposition.optional(),
  bizTransactionList: z.array(BizTransaction).optional(),

  /** HOW. */
  sensorElementList: z.array(SensorElement).optional(),

  /**
   * Namespaced extension: WHO the event claims to have been captured by.
   *
   * CBV has no field for "the individual who pressed the button" — EPCIS models
   * parties and locations, not staff. Naming it in our own namespace keeps it
   * visibly distinct from the standard fields around it.
   *
   * THIS IS A CLAIM, NEVER A FACT. It is attacker-controlled: anyone who can
   * submit an event can put any courier ID in this field. It must never be
   * trusted directly, and must never be treated as having established identity.
   * Its only legitimate use is as the subject of cross-checks:
   *
   *   I6     — does the scanning device match the binding this courier has?
   *   H2/H3  — is the claimed courier's mandate active, and does its scope
   *            actually cover this EPC and this bizStep?
   *
   * A claim that survives those checks is corroborated. A claim that is merely
   * present is worth nothing.
   */
  "vigil:courierId": z.string().min(1).optional(),
};

/**
 * ObjectEvent — a scan. The workhorse: pickup, sortation, line-haul, delivery.
 */
export const ObjectEvent = z.strictObject({
  type: z.literal("ObjectEvent"),
  ...EventBase,
  /** WHAT. */
  epcList: z.array(EpcUri).min(1),
  action: Action,
});
export type ObjectEvent = z.infer<typeof ObjectEvent>;

/**
 * TransactionEvent — a handoff. Custody moves between named parties, which is
 * what makes it the event type our whole trust question is actually about.
 */
export const TransactionEvent = z.strictObject({
  type: z.literal("TransactionEvent"),
  ...EventBase,
  epcList: z.array(EpcUri).min(1),
  action: Action,
  /** A handoff without a transaction reference is not a handoff. */
  bizTransactionList: z.array(BizTransaction).min(1),
  /** WHY, extended: the parties on each side of the custody transfer. */
  sourceList: z.array(z.strictObject({ type: z.string(), source: PartyId })).optional(),
  destinationList: z
    .array(z.strictObject({ type: z.string(), destination: PartyId }))
    .optional(),
});
export type TransactionEvent = z.infer<typeof TransactionEvent>;

/**
 * AssociationEvent — binding a device (or container) to a parent.
 * We use it for courier-to-handset binding, which is what makes I6
 * ("scan came from an unbound device") a checkable claim rather than a guess.
 */
export const AssociationEvent = z.strictObject({
  type: z.literal("AssociationEvent"),
  ...EventBase,
  /** The parent the children are being associated with, e.g. a handset or a cage. */
  parentID: z.string().min(1),
  childEPCs: z.array(EpcUri).optional(),
  action: Action,
});
export type AssociationEvent = z.infer<typeof AssociationEvent>;

/** Any event Vigil accepts at ingest. */
export const EpcisEvent = z.discriminatedUnion("type", [
  ObjectEvent,
  TransactionEvent,
  AssociationEvent,
]);
export type EpcisEvent = z.infer<typeof EpcisEvent>;

/** EPCIS 2.0 document envelope — how events arrive in batches. */
export const EpcisDocument = z.strictObject({
  "@context": z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
  type: z.literal("EPCISDocument"),
  schemaVersion: z.string(),
  creationDate: Iso8601WithOffset,
  epcisBody: z.strictObject({
    eventList: z.array(EpcisEvent).min(1),
  }),
});
export type EpcisDocument = z.infer<typeof EpcisDocument>;

/** Narrowing helpers, so callers stop reaching for `as`. */
export const isObjectEvent = (e: EpcisEvent): e is ObjectEvent => e.type === "ObjectEvent";
export const isTransactionEvent = (e: EpcisEvent): e is TransactionEvent =>
  e.type === "TransactionEvent";
export const isAssociationEvent = (e: EpcisEvent): e is AssociationEvent =>
  e.type === "AssociationEvent";

/** The EPCs an event touches, whichever dimension they sit in. */
export function epcsOf(event: EpcisEvent): string[] {
  if (isAssociationEvent(event)) return event.childEPCs ?? [];
  return event.epcList;
}

/** The first vigil: signal bundle on the event, if any. */
export function vigilSignalsOf(event: EpcisEvent) {
  return event.sensorElementList?.find((el) => el["vigil:signals"])?.["vigil:signals"];
}

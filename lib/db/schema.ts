import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * SQLite schema: parcels, couriers, mandates, events, verdicts, reference_sites, disputes.
 *
 * WHAT IS NOT HERE, AND WHY
 * -------------------------
 * The nonce ledger is not a table. It is an append-only, hash-chained JSONL file
 * (lib/ledger). Rows are mutable by anyone with a connection; the file's chain is
 * self-verifying. Putting the replay registry here would quietly downgrade the
 * strongest tamper-evidence claim in the system into a promise about our own code.
 *
 * The `verdicts` table below is a queryable PROJECTION for the operator console.
 * The ledger remains the record of truth. If they ever disagree, the ledger wins.
 */

/** A parcel, keyed by its EPC pure-identity URI. */
export const parcels = sqliteTable(
  "parcels",
  {
    epc: text("epc").primaryKey(),
    /** Waybill / order reference the customer would quote. */
    waybillNo: text("waybill_no").notNull(),
    recipientName: text("recipient_name").notNull(),
    recipientPhone: text("recipient_phone"),
    /** Destination address, and its coordinates for the I10/I11 distance checks. */
    recipientAddress: text("recipient_address").notNull(),
    // REAL, not INTEGER. Coordinates are fractional; an integer column would
    // declare 3.1595 to be a whole number. SQLite's dynamic typing meant this
    // survived a round trip, so the error hid behind test fixtures that built
    // coordinates by hand instead of reading them back through the schema.
    recipientLat: real("recipient_lat"),
    recipientLng: real("recipient_lng"),
    /** Declared value in sen (integer cents) — drives the co-sign threshold. */
    declaredValueSen: integer("declared_value_sen").notNull().default(0),
    codAmountSen: integer("cod_amount_sen").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
  },
  (t) => [index("parcels_waybill_idx").on(t.waybillNo)],
);

/** A courier, and the public half of the key their device signs handoffs with. */
export const couriers = sqliteTable("couriers", {
  courierId: text("courier_id").primaryKey(),
  displayName: text("display_name").notNull(),
  /** Ed25519 public key, base64. The private half never leaves the device. */
  publicKey: text("public_key").notNull(),
  /** Device the courier is bound to. A scan from anything else is the I6 contradiction. */
  boundDeviceId: text("bound_device_id"),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

/**
 * A CourierMandate: scope, limits, validity, and the conditions that force a co-sign.
 *
 * Stored as JSON text rather than exploded into columns because the mandate is
 * validated by a zod schema at both ends, and a mandate is only ever read whole.
 * Splitting it into twenty columns would create twenty ways to read half of one.
 */
export const mandates = sqliteTable(
  "mandates",
  {
    mandateId: text("mandate_id").primaryKey(),
    courierId: text("courier_id")
      .notNull()
      .references(() => couriers.courierId),
    /** "standard" | "trusted" — the two presets. Neither disables the engine. */
    preset: text("preset", { enum: ["standard", "trusted"] }).notNull(),
    /** JSON: { epcPrefixes, bizLocations, bizSteps }. */
    scopeJson: text("scope_json").notNull(),
    /** JSON: { maxHandoffsPerShift, codCashCapSen, maxParcelValueSen }. */
    limitsJson: text("limits_json").notNull(),
    /** JSON: { notBefore, notAfter, timeWindows }. */
    validityJson: text("validity_json").notNull(),
    /** JSON: array of co-sign trigger conditions. */
    requiresCosignIfJson: text("requires_cosign_if_json").notNull(),
    cooldownSeconds: integer("cooldown_seconds").notNull().default(0),
    status: text("status", { enum: ["active", "paused", "revoked"] })
      .notNull()
      .default("active"),
    /** Monotonic counter for mandate-scoped replay protection. */
    nonceCounter: integer("nonce_counter").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
  },
  (t) => [index("mandates_courier_idx").on(t.courierId, t.status)],
);

/**
 * Ingested EPCIS events, stored whole as JSON alongside the columns we query on.
 *
 * The raw document is kept verbatim because our own extraction is a
 * *reading* of the evidence, and an audit trail that only keeps the reading
 * cannot be re-examined when the reading turns out to be wrong.
 */
export const events = sqliteTable(
  "events",
  {
    eventId: text("event_id").primaryKey(),
    type: text("type", {
      enum: ["ObjectEvent", "TransactionEvent", "AssociationEvent"],
    }).notNull(),

    /** WHEN: both clocks, kept apart. Their divergence is a free tampering detector. */
    eventTime: text("event_time").notNull(),
    recordTime: text("record_time").notNull(),
    eventTimeZoneOffset: text("event_time_zone_offset").notNull(),

    /** WHERE. */
    readPoint: text("read_point"),
    bizLocation: text("biz_location"),

    /** WHY. */
    bizStep: text("biz_step"),
    disposition: text("disposition"),

    /** WHO — denormalised from the mandate for per-courier pattern queries. */
    courierId: text("courier_id").references(() => couriers.courierId),
    /** Primary EPC; the full list lives in payloadJson. */
    primaryEpc: text("primary_epc"),

    /** The verbatim EPCIS event. */
    payloadJson: text("payload_json").notNull(),
    /** canonicalHash of payloadJson — the same value bound in the ledger. */
    payloadHash: text("payload_hash").notNull(),
  },
  (t) => [
    // Axis 2 (pattern scoring) is always "this courier, this window", so the
    // rolling-window queries are indexed for exactly that shape.
    index("events_courier_time_idx").on(t.courierId, t.eventTime),
    index("events_epc_time_idx").on(t.primaryEpc, t.eventTime),
  ],
);

/**
 * Operator-facing projection of a verdict.
 *
 * The two scores are separate columns and are never summed into one. Collapsing
 * them would destroy the orthogonal gate, which is the whole argument. See CLAUDE.md.
 */
export const verdicts = sqliteTable(
  "verdicts",
  {
    verdictId: text("verdict_id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.eventId),
    /** Ledger sequence number this verdict was sealed at. */
    ledgerSeq: integer("ledger_seq").notNull(),

    decision: text("decision", {
      enum: ["accept", "flag", "escalate", "freeze"],
    }).notNull(),
    /** Axis 1 — single-event contradiction (H1-H4, I1-I14). */
    inconsistencyScore: integer("inconsistency_score").notNull(),
    /** Axis 2 — per-courier rolling pattern (P1-P5). */
    patternScore: integer("pattern_score").notNull(),
    /** JSON array of flag codes, e.g. ["I4","I10"]. */
    flagsJson: text("flags_json").notNull(),
    /** Set when a hard check (H1-H4) aborted the event outright. */
    abortCode: text("abort_code"),
    /**
     * What the decision rests on. Mirrors the sealed ledger Verdict: without it,
     * an accept made on a full picture and an accept made because the courier is
     * new look identical in the console.
     */
    basis: text("basis", {
      enum: ["both_axes", "single_event_only", "insufficient_evidence"],
    })
      .notNull()
      .default("both_axes"),

    /** Co-sign state. Absent operator signature is a CRYPTOGRAPHIC gap, not a flag. */
    requiresCosign: integer("requires_cosign", { mode: "boolean" })
      .notNull()
      .default(false),
    courierSignature: text("courier_signature"),
    operatorSignature: text("operator_signature"),
    operatorId: text("operator_id"),

    /** LLM-authored operator explanation. Nullable: verdicts exist without it. */
    explanation: text("explanation"),

    createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
  },
  (t) => [
    uniqueIndex("verdicts_event_uidx").on(t.eventId),
    index("verdicts_triage_idx").on(t.decision, t.createdAt),
  ],
);

/**
 * Positioning sources whose real-world location we know independently of GPS.
 *
 * I1 needs these: a courier can choose what their GPS reports, but not where
 * the tower they are connected to actually stands. Without this table I1 is
 * permanently `not_evaluated` and S1 (spoofing) cannot be demonstrated at all.
 */
export const referenceSites = sqliteTable(
  "reference_sites",
  {
    /** Cell id as observed ("mcc-mnc-lac-cellid"), or a WiFi BSSID. */
    siteId: text("site_id").primaryKey(),
    kind: text("kind", { enum: ["cell", "wifi"] }).notNull(),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    /** Human-readable location, for the operator console. */
    label: text("label"),
  },
  (t) => [index("reference_sites_kind_idx").on(t.kind)],
);

/**
 * "Delivered, but the customer says it never arrived."
 *
 * The one input that is an outcome rather than a sensor reading: whatever the
 * evidence said at the time, the recipient disagrees. P2 compares a courier's
 * rate against the fleet's, and the fleet baseline is COMPUTED from this table
 * rather than stored — a stored baseline is a number nobody can check.
 */
export const disputes = sqliteTable(
  "disputes",
  {
    disputeId: text("dispute_id").primaryKey(),
    /** The handoff being disputed. */
    eventId: text("event_id")
      .notNull()
      .references(() => events.eventId),
    epc: text("epc").notNull(),
    raisedAt: text("raised_at").notNull(),
    kind: text("kind", { enum: ["not_received", "damaged", "wrong_item"] })
      .notNull()
      .default("not_received"),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("disputes_event_uidx").on(t.eventId),
    index("disputes_raised_idx").on(t.raisedAt),
  ],
);

/** Fixed operational destinations that a flagged parcel may be returned to. */
export const pickupPoints = sqliteTable(
  "pickup_points",
  {
    pickupPointId: text("pickup_point_id").primaryKey(),
    label: text("label").notNull(),
    address: text("address").notNull(),
    bizLocation: text("biz_location").notNull(),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("pickup_points_biz_location_uidx").on(t.bizLocation)],
);

/**
 * Post-gate reroute proposals and their constitutive approval state.
 *
 * This is not EPCIS evidence and is not folded into the handoff verdict. The
 * credential JSON binds the exact action and can be re-verified independently.
 */
export const rerouteProposals = sqliteTable(
  "reroute_proposals",
  {
    proposalId: text("proposal_id").primaryKey(),
    sourceEventId: text("source_event_id")
      .notNull()
      .references(() => events.eventId),
    epc: text("epc").notNull(),
    currentCourierId: text("current_courier_id").notNull(),
    kind: text("kind", { enum: ["pickup_point", "courier_reassignment"] }).notNull(),
    targetId: text("target_id").notNull(),
    targetLabel: text("target_label").notNull(),
    targetBizLocation: text("target_biz_location").notNull(),
    targetLat: real("target_lat").notNull(),
    targetLng: real("target_lng").notNull(),
    authorizingMandateId: text("authorizing_mandate_id").notNull(),
    approvalState: text("approval_state", {
      enum: ["pending_operator_cosignature", "approved"],
    })
      .notNull()
      .default("pending_operator_cosignature"),
    credentialJson: text("credential_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("reroute_proposals_event_uidx").on(t.sourceEventId),
    index("reroute_proposals_state_idx").on(t.approvalState, t.createdAt),
  ],
);

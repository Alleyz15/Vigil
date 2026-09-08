import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { VigilDb } from "@/lib/db/client";
import { disputes, events, parcels, verdicts } from "@/lib/db/schema";
import { DEFAULT_PATTERN_THRESHOLDS } from "@/lib/pattern";
import type { PastHandoff, PatternInput, QueueBaseline } from "@/lib/pattern/types";
import { BizStep, EpcisEvent, type GeoPoint, vigilSignalsOf } from "@/lib/epcis";
import { type Assembled, emptyResolution, missing, resolved } from "./types";

/** How far back the rolling pattern window reaches. See CLAUDE.md, Open reservations. */
export const DEFAULT_PATTERN_WINDOW_HOURS = 24;

/**
 * Assemble the axis-2 input for one courier.
 *
 * The window query is the shape `events_courier_time_idx` (courier_id,
 * event_time) exists for: an equality on the courier and a range on the time,
 * in that order.
 */
export function assemblePatternInput(
  db: VigilDb,
  courierId: string,
  now: string,
  options: {
    windowHours?: number;
    thresholds?: PatternInput["thresholds"];
  } = {},
): Assembled<PatternInput> {
  const resolution = emptyResolution();
  const windowHours = options.windowHours ?? DEFAULT_PATTERN_WINDOW_HOURS;
  const from = new Date(Date.parse(now) - windowHours * 3_600_000).toISOString();

  const rows = db
    .select({
      eventId: events.eventId,
      eventTime: events.eventTime,
      bizStep: events.bizStep,
      primaryEpc: events.primaryEpc,
      payloadJson: events.payloadJson,
      inconsistencyScore: verdicts.inconsistencyScore,
      flagsJson: verdicts.flagsJson,
      recipientLat: parcels.recipientLat,
      recipientLng: parcels.recipientLng,
      disputeId: disputes.disputeId,
    })
    .from(events)
    .leftJoin(verdicts, eq(verdicts.eventId, events.eventId))
    .leftJoin(parcels, eq(parcels.epc, events.primaryEpc))
    .leftJoin(disputes, eq(disputes.eventId, events.eventId))
    .where(and(eq(events.courierId, courierId), gte(events.eventTime, from), lt(events.eventTime, now)))
    .orderBy(events.eventTime)
    .all();

  const handoffs: PastHandoff[] = [];
  let withoutVerdict = 0;

  for (const row of rows) {
    // A stored event with no verdict has not been through the engine. Its
    // axis-1 score is unknown, and P3 measures the SPREAD of those scores — so
    // substituting a zero would fabricate the very tightness P3 looks for.
    if (row.inconsistencyScore === null) {
      withoutVerdict++;
      continue;
    }

    const parsed = EpcisEvent.safeParse(JSON.parse(row.payloadJson));
    const signals = parsed.success ? vigilSignalsOf(parsed.data) : undefined;

    const recipientPoint: GeoPoint | undefined =
      row.recipientLat !== null && row.recipientLng !== null
        ? { latitude: row.recipientLat, longitude: row.recipientLng }
        : undefined;

    handoffs.push({
      eventID: row.eventId,
      eventTime: row.eventTime,
      bizStep: BizStep.safeParse(row.bizStep).data,
      inconsistencyScore: row.inconsistencyScore,
      flagIds: parseFlags(row.flagsJson),
      scanPoint: signals?.gps?.point,
      recipientPoint,
      disputed: row.disputeId !== null,
    });
  }

  if (withoutVerdict > 0) {
    missing(
      resolution,
      "handoffs",
      `${withoutVerdict} event(s) in the window have no sealed verdict and were excluded`,
    );
  }
  if (handoffs.length > 0) {
    resolved(resolution, `${handoffs.length} handoff(s) in the ${windowHours}h window`);
  } else {
    missing(resolution, "handoffs", `no scored handoffs for ${courierId} in the ${windowHours}h window`);
  }

  const queueBaseline = computeQueueBaseline(db, from, now, resolution);

  return {
    input: {
      courierId,
      window: { from, to: now },
      handoffs,
      queueBaseline,
      thresholds: options.thresholds ?? DEFAULT_PATTERN_THRESHOLDS,
    },
    resolution,
  };
}

function parseFlags(flagsJson: string | null): string[] {
  if (!flagsJson) return [];
  try {
    const parsed = JSON.parse(flagsJson);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The fleet's dispute rate over the same window.
 *
 * COMPUTED, not stored. P2 accuses a courier of being worse than their peers,
 * and that comparison should be recomputed from the same rows an auditor could
 * recount — a cached baseline is a number nobody can check, and it silently
 * ages.
 *
 * Returns undefined when there is nothing to compare against, so P2 reports
 * `not_evaluated` rather than measuring a courier against a zero.
 */
function computeQueueBaseline(
  db: VigilDb,
  from: string,
  to: string,
  resolution: ReturnType<typeof emptyResolution>,
): QueueBaseline | undefined {
  // Mirrors DELIVERY_STEPS in lib/engine/inconsistency.ts: the baseline must be
  // computed over the same events the courier's own rate is computed over.
  const DELIVERY_STEPS = [
    "urn:epcglobal:cbv:bizstep:delivering",
    "urn:epcglobal:cbv:bizstep:accepting",
  ] as const;

  const totals = db
    .select({
      deliveries: sql<number>`count(*)`,
      disputed: sql<number>`sum(case when ${disputes.disputeId} is not null then 1 else 0 end)`,
    })
    .from(events)
    .leftJoin(disputes, eq(disputes.eventId, events.eventId))
    .where(
      and(
        inArray(events.bizStep, DELIVERY_STEPS),
        gte(events.eventTime, from),
        lt(events.eventTime, to),
      ),
    )
    .get();

  const sampleSize = totals?.deliveries ?? 0;
  if (sampleSize === 0) {
    missing(resolution, "queueBaseline", "no fleet deliveries in the window to compare against");
    return undefined;
  }

  resolved(resolution, `queue baseline over ${sampleSize} fleet deliveries`);
  return { disputeRate: (totals?.disputed ?? 0) / sampleSize, sampleSize };
}

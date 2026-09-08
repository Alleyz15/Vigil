import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { VigilDb } from "@/lib/db/client";
import { events, parcels, verdicts } from "@/lib/db/schema";
import type { EngineResult } from "@/lib/engine/types";
import { DEFAULT_GATE_THRESHOLDS } from "@/lib/gate";
import type { GateInput, ParcelValue, ShiftContext } from "@/lib/gate/types";
import type { CourierMandate } from "@/lib/mandate/schema";
import type { PatternOutcome } from "@/lib/pattern/types";
import type { Decision } from "@/lib/ledger/types";
import { type Assembled, emptyResolution, missing, resolved } from "./types";

/**
 * How far back "this shift" reaches.
 *
 * A SIMPLIFICATION. Real fleets work rostered shifts with defined start times;
 * this is a rolling window, and the two diverge at the boundary — a courier who
 * started at 06:00 is measured against a window that keeps sliding rather than
 * one that resets. The shift cap is a HARD STOP in the mandate, so the
 * divergence matters. It is in CLAUDE.md's Open reservations and belongs in the
 * submission's Known Limitations.
 */
export const DEFAULT_SHIFT_WINDOW_HOURS = 12;

/** Decisions that count as a high-risk handoff for the cooldown. */
const HIGH_RISK_DECISIONS = ["flag", "escalate", "freeze"] as const satisfies readonly Decision[];

export function assembleGateInput(
  db: VigilDb,
  args: {
    inconsistency: EngineResult;
    pattern: PatternOutcome;
    courierId?: string;
    mandate?: CourierMandate;
    epc?: string;
    /** This event's time; the cooldown and shift window are measured from it. */
    now: string;
    shiftWindowHours?: number;
    thresholds?: GateInput["thresholds"];
  },
): Assembled<GateInput> {
  const resolution = emptyResolution();

  const shift = args.courierId
    ? loadShiftContext(db, args.courierId, args.now, args.shiftWindowHours ?? DEFAULT_SHIFT_WINDOW_HOURS, resolution)
    : undefined;

  const parcel = args.epc ? loadParcelValue(db, args.epc, args.mandate, resolution) : undefined;

  return {
    input: {
      inconsistency: args.inconsistency,
      pattern: args.pattern,
      mandate: args.mandate,
      shift,
      parcel,
      thresholds: args.thresholds ?? DEFAULT_GATE_THRESHOLDS,
    },
    resolution,
  };
}

/**
 * Handoffs so far this shift, and when the last high-risk one was sealed.
 *
 * Both queries lead on `events_courier_time_idx` (courier_id, event_time).
 */
function loadShiftContext(
  db: VigilDb,
  courierId: string,
  now: string,
  windowHours: number,
  resolution: ReturnType<typeof emptyResolution>,
): ShiftContext {
  const shiftStart = new Date(Date.parse(now) - windowHours * 3_600_000).toISOString();

  const counted = db
    .select({ n: sql<number>`count(*)` })
    .from(events)
    .where(and(eq(events.courierId, courierId), gte(events.eventTime, shiftStart), lt(events.eventTime, now)))
    .get();

  const lastHighRisk = db
    .select({ eventTime: events.eventTime })
    .from(events)
    .innerJoin(verdicts, eq(verdicts.eventId, events.eventId))
    .where(
      and(
        eq(events.courierId, courierId),
        gte(events.eventTime, shiftStart),
        lt(events.eventTime, now),
        inArray(verdicts.decision, HIGH_RISK_DECISIONS),
      ),
    )
    .orderBy(desc(events.eventTime))
    .limit(1)
    .get();

  resolved(resolution, `shift context over the last ${windowHours}h`);
  if (!lastHighRisk) {
    missing(resolution, "shift.lastHighRiskHandoffAt", "no high-risk handoff this shift; cooldown does not apply");
  }

  return {
    handoffsThisShift: counted?.n ?? 0,
    lastHighRiskHandoffAt: lastHighRisk?.eventTime,
    now,
  };
}

/**
 * What the parcel is worth, and whether its address is inside the mandate.
 *
 * `recipientAddressInScope` defaults to TRUE only when the mandate places no
 * location restriction at all. An unknown address against a restricted mandate
 * is out of scope, because "we could not tell" must not read as "permitted".
 */
function loadParcelValue(
  db: VigilDb,
  epc: string,
  mandate: CourierMandate | undefined,
  resolution: ReturnType<typeof emptyResolution>,
): ParcelValue | undefined {
  const row = db.select().from(parcels).where(eq(parcels.epc, epc)).get();
  if (!row) {
    missing(resolution, "parcelValue", `no parcel on file for ${epc}`);
    return undefined;
  }

  const restricted = (mandate?.scope.bizLocations.length ?? 0) > 0;
  const inScope = !restricted
    ? true
    : mandate!.scope.epcPrefixes.some((prefix) => epc.startsWith(prefix));

  resolved(resolution, `parcel value for ${epc}`);
  return {
    declaredValueSen: row.declaredValueSen,
    codAmountSen: row.codAmountSen,
    recipientAddressInScope: inScope,
  };
}

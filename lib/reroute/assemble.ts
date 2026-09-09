import { eq } from "drizzle-orm";
import type { VigilDb } from "@/lib/db/client";
import { couriers, mandates, pickupPoints } from "@/lib/db/schema";
import type { AgentContext } from "@/lib/agent/context";
import { CourierMandate } from "@/lib/mandate/schema";
import type { RerouteInput } from "./types";

function parseMandate(row: typeof mandates.$inferSelect): CourierMandate | undefined {
  try {
    return CourierMandate.parse({
      mandateId: row.mandateId,
      courierId: row.courierId,
      preset: row.preset,
      scope: JSON.parse(row.scopeJson),
      limits: JSON.parse(row.limitsJson),
      validity: JSON.parse(row.validityJson),
      requiresCosignIf: JSON.parse(row.requiresCosignIfJson),
      cooldownSeconds: row.cooldownSeconds,
      status: row.status,
      nonceCounter: row.nonceCounter,
    });
  } catch {
    // Same fail-closed rule as the handoff assembler: unreadable authorisation
    // is not an unrestricted mandate.
    return undefined;
  }
}

/** WHERE THE I/O IS: database rows into the pure reroute policy input. */
export function assembleRerouteInput(db: VigilDb, ctx: AgentContext): RerouteInput | undefined {
  const event = ctx.event;
  const verdict = ctx.verdict;
  const courierId = ctx.courier?.known ? ctx.courier.courierId : undefined;
  const epc = ctx.parcel?.known ? ctx.parcel.epc : undefined;
  if (!event || !verdict || !courierId || !epc) return undefined;

  const activeCourierIds = new Set(
    db
      .select({ courierId: couriers.courierId })
      .from(couriers)
      .where(eq(couriers.status, "active"))
      .all()
      .map((row) => row.courierId),
  );

  const alternateCouriers = db
    .select()
    .from(mandates)
    .where(eq(mandates.status, "active"))
    .all()
    .flatMap((row) => {
      const mandate = parseMandate(row);
      return mandate && activeCourierIds.has(row.courierId)
        ? [{ courierId: row.courierId, mandate }]
        : [];
    });

  return {
    decision: verdict.decision,
    sourceEventID: event.eventID,
    epc,
    currentCourierId: courierId,
    currentMandate: ctx.mandate?.value,
    eventTime: event.eventTime,
    destination: ctx.parcel?.recipientPoint
      ? {
          bizLocation: event.bizLocation?.id,
          latitude: ctx.parcel.recipientPoint.latitude,
          longitude: ctx.parcel.recipientPoint.longitude,
        }
      : undefined,
    pickupPoints: db
      .select()
      .from(pickupPoints)
      .where(eq(pickupPoints.active, true))
      .all()
      .map((row) => ({
        pickupPointId: row.pickupPointId,
        label: row.label,
        bizLocation: row.bizLocation,
        latitude: row.lat,
        longitude: row.lng,
        active: row.active,
      })),
    alternateCouriers,
  };
}


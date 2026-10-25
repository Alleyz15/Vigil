import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { DeviceRecognitionVerdict, EpcisEvent, GeoPoint, Iso8601WithOffset } from "@/lib/epcis";
import type { BuiltEvent, GeneratedScenario } from "@/lib/generate";
import type { VigilDb } from "@/lib/db/client";
import { shipments } from "@/lib/db/schema";
import { canonicalHash } from "@/lib/ledger";

const Otp = z.strictObject({
  challengeId: z.string(), epc: z.string(), recipientChannelFingerprint: z.string(),
  deliveryStatus: z.enum(["delivered", "failed", "unknown"]),
  verificationReceiptId: z.string().nullable().optional(), issuedAt: Iso8601WithOffset,
  expiresAt: Iso8601WithOffset, verifiedAt: Iso8601WithOffset.nullable().optional(), consumedByEventId: z.string().nullable().optional(),
});
const Built: z.ZodType<BuiltEvent> = z.strictObject({
  leg: z.enum(["collection", "sortation", "linehaul_departure", "linehaul_arrival", "out_for_delivery", "delivery"]),
  legIndex: z.number().int().nonnegative(), event: EpcisEvent,
  raw: z.record(z.string(), z.unknown()),
  identity: z.strictObject({ otpChallenge: Otp.optional(), deviceEnrollment: z.strictObject({
    deviceId: z.string(), requiredRecognitionVerdict: DeviceRecognitionVerdict,
    courierId: z.string(), enrolledAt: Iso8601WithOffset,
  }).optional() }).optional(),
});
const Parcel = z.strictObject({ epc: z.string(), waybillNo: z.string(), recipientName: z.string(),
  recipientPhone: z.string(), recipientAddress: z.string(), recipientPoint: GeoPoint,
  declaredValueSen: z.number().int(), codAmountSen: z.number().int() });
const Provenance = z.object({ mode: z.literal("randomized"), seed: z.string(), version: z.literal("signals-v1"),
  conditions: z.array(z.object({ source: z.enum(["environment", "behavior"]), code: z.string(), label: z.string() })),
  history: z.object({ runId: z.string(), priorHandoffs: z.number().int().nonnegative(), source: z.literal("simulated"), snapshotAt: Iso8601WithOffset }).optional(),
}).passthrough();
const Snapshot = z.strictObject({ version: z.literal(1), courierId: z.string(), simulationRunId: z.string(),
  startMs: z.number().finite(), timeline: z.array(Built).min(1), warmup: z.array(Built),
  parcels: z.array(Parcel).min(1), disputedEventIds: z.array(z.string()), simulation: Provenance,
});

export function loadSimulationSnapshot(raw: string, expected: { courierId: string; simulationRunId: string }) {
  const snapshot = Snapshot.parse(JSON.parse(raw));
  if (snapshot.courierId !== expected.courierId || snapshot.simulationRunId !== expected.simulationRunId) {
    throw new Error("The saved simulation belongs to a different courier or earlier process run; it cannot be reassigned or resumed here.");
  }
  return snapshot;
}

/** Store only generated facts and independent references, never signing keys. */
export function persistSimulationSnapshot(db: VigilDb, shipmentId: string, input: {
  courierId: string; simulationRunId: string; startMs: number; scenario: GeneratedScenario;
}) {
  const snapshot = Snapshot.parse({ version: 1, courierId: input.courierId, simulationRunId: input.simulationRunId,
    startMs: input.startMs, timeline: input.scenario.timeline, warmup: input.scenario.warmup,
    parcels: input.scenario.parcels, disputedEventIds: input.scenario.disputedEventIds, simulation: input.scenario.simulation });
  const serialized = JSON.stringify(snapshot);
  const row = db.select().from(shipments).where(eq(shipments.shipmentId, shipmentId)).get();
  if (!row) throw new Error("The simulation shipment is unavailable.");
  if (row.simulationSnapshotJson !== null) {
    if (canonicalHash(loadSimulationSnapshot(row.simulationSnapshotJson, input)) !== canonicalHash(snapshot)) {
      throw new Error("The saved simulation facts are immutable; retry the original preparation.");
    }
    return;
  }
  const result = db.update(shipments).set({ simulationSnapshotJson: serialized })
    .where(and(eq(shipments.shipmentId, shipmentId), isNull(shipments.simulationSnapshotJson))).run();
  if (!result.changes) throw new Error("The simulation was prepared concurrently; reload its original facts.");
}

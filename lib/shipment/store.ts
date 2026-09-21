import { randomUUID } from "node:crypto";
import { asc, eq, TransactionRollbackError } from "drizzle-orm";
import type { VigilDb } from "@/lib/db/client";
import { locationCorrections, locationSnapshots, shipments } from "@/lib/db/schema";
import { canonicalHash } from "@/lib/ledger/canonical";
import type { ResolvedLabel } from "@/lib/geocode/attach";
import { checkPoint, type ServiceBoundary } from "./boundary";
import { COORDINATE_DECIMALS } from "./picker";
import { routeBetween, type Point } from "./depot";

/**
 * Online shipments: created once per idempotency key, located by a point a
 * person confirmed, corrected only by appending.
 *
 * WHY NOT `uuidFrom`. The generator derives ids from a string with two
 * correlated 32-bit states, and session 17B's silent overwrite came from two
 * "different" shipments deriving the same id. An online shipment's identity is
 * therefore minted by the server (`randomUUID`) and made unique by the database,
 * not by hoping two strings hash apart.
 *
 * THREE OUTCOMES FOR A CREATE, NEVER TWO:
 *
 *   created   a new key            → a new shipment, even at an address already
 *                                    on file: two parcels to one door are two parcels
 *   replayed  same key, same body  → the SAME shipment back; a retry on a flaky
 *                                    connection must not create a second parcel
 *   conflict  same key, other body → refused; a key reused for different content
 *                                    is a client bug or worse, and guessing which
 *                                    body was meant would be inventing a request
 *
 * Rule 5's reasoning at the shipment level: the honest double-tap and the
 * mismatched reuse are the two cases the design exists to tell apart.
 */

export type LocationInput = Point & {
  /**
   * What the sender typed for this point, if anything. Stored verbatim; nothing
   * parses it, and nothing supplies one when it is absent.
   *
   * OPTIONAL. A confirmed coordinate need not have an address — asking a person
   * to type one before they may dispatch would make the field look like a
   * lookup that succeeded. (Phase two's geocoder does not change this: what it
   * finds goes in `resolved`, never here.) Absent is stored as the empty
   * string, which is not a claim anyone can type: `normaliseClaim` trims, so a
   * claim is non-empty by construction. Read it back through `addressClaimOf`
   * rather than testing for `""` at each call site.
   */
  addressClaim?: string;
  /**
   * What the GEOCODER said about the point, verified server-side against its
   * cache (`verifyResolution`) — never text a client supplied. Kept apart from
   * `addressClaim` all the way to the screen: one is the sender's words, the
   * other a provider's label, and a single field holding either would let each
   * pass for the other.
   */
  resolved?: ResolvedLabel;
};

/** The geocoder's label on a stored snapshot, or `null` where nothing was resolved. */
export function resolvedOf(snapshot: {
  resolvedLabel: string | null;
  resolvedBy: "search" | "reverse" | null;
  resolvedRef: string | null;
}): ResolvedLabel | null {
  return snapshot.resolvedLabel && snapshot.resolvedBy && snapshot.resolvedRef
    ? { label: snapshot.resolvedLabel, by: snapshot.resolvedBy, ref: snapshot.resolvedRef }
    : null;
}

/** The claim on a stored snapshot, or `null` where nobody made one. */
export function addressClaimOf(snapshot: { addressClaim: string }): string | null {
  return snapshot.addressClaim.trim().length > 0 ? snapshot.addressClaim : null;
}

/**
 * A snapshot's display line: the claim if there is one, otherwise the
 * coordinate said plainly as a coordinate. Never a street nobody resolved.
 */
export function addressLabelOf(snapshot: {
  addressClaim: string;
  latitude: number;
  longitude: number;
}): string {
  return (
    addressClaimOf(snapshot) ??
    `${snapshot.latitude.toFixed(COORDINATE_DECIMALS)}, ${snapshot.longitude.toFixed(COORDINATE_DECIMALS)} (no address claimed)`
  );
}

export type ShipmentRequest = {
  origin: LocationInput;
  destination: LocationInput;
  declaredValueSen: number;
  codAmountSen?: number;
  recipientChannel: string;
  recipientName?: string;
};

export type LocationSnapshot = typeof locationSnapshots.$inferSelect;
export type ShipmentRow = typeof shipments.$inferSelect;
export type CorrectionRow = typeof locationCorrections.$inferSelect;

export type CreateResult =
  | { status: "created"; shipment: ShipmentRow }
  | { status: "replayed"; shipment: ShipmentRow }
  | { status: "conflict"; reason: string }
  | {
      status: "rejected";
      field: "origin" | "destination";
      code: string;
      reason: string;
    };

/** The request as hashed: defaults filled in, so an omitted 0 and an explicit 0 are one request. */
function normalised(request: ShipmentRequest) {
  const point = (location: LocationInput) => ({
    latitude: location.latitude,
    longitude: location.longitude,
    // Explicit, so "no claim sent" and "empty claim sent" are ONE request
    // rather than two hashes — a retry that drops an empty field is still the
    // same shipment (rule 5's reasoning, at the field level).
    addressClaim: location.addressClaim?.trim() || null,
    // Present ONLY when resolved, so a request with no resolution hashes exactly
    // as it did before phase two: a shipment created then still replays now.
    ...(location.resolved ? { resolved: location.resolved } : {}),
  });
  return {
    origin: point(request.origin),
    destination: point(request.destination),
    declaredValueSen: request.declaredValueSen,
    codAmountSen: request.codAmountSen ?? 0,
    recipientChannel: request.recipientChannel,
    recipientName: request.recipientName ?? null,
  };
}

export function requestHashOf(request: ShipmentRequest): string {
  return canonicalHash(normalised(request));
}

export function createShipment(
  db: VigilDb,
  input: {
    request: ShipmentRequest;
    idempotencyKey: string;
    boundary: ServiceBoundary | null;
    nowIso: string;
  },
): CreateResult {
  const { request, idempotencyKey, boundary, nowIso } = input;

  // Both ends are checked before anything is written; a refused request leaves no row.
  const originCheck = checkPoint(request.origin, boundary);
  if (!originCheck.ok)
    return {
      status: "rejected",
      field: "origin",
      code: originCheck.code,
      reason: originCheck.reason,
    };
  const destinationCheck = checkPoint(request.destination, boundary);
  if (!destinationCheck.ok) {
    return {
      status: "rejected",
      field: "destination",
      code: destinationCheck.code,
      reason: destinationCheck.reason,
    };
  }

  const requestHash = requestHashOf(request);
  const shipmentId = randomUUID();
  const route = routeBetween(request.origin, request.destination);

  /**
   * INSERT FIRST, THEN READ BACK. There is no "does this key exist?" check
   * before the write, so there is no gap for a second writer to fall into: the
   * unique index on the key decides who created the shipment, and everyone
   * else reads the winner. A writer that arrives after the winner is the same
   * case as one that raced it.
   */
  try {
    db.transaction(
      (tx) => {
        const originSnapshotId = randomUUID();
        const referenceSnapshotId = randomUUID();
        tx.insert(locationSnapshots)
          .values([
            snapshotRow(
              originSnapshotId,
              shipmentId,
              "origin",
              request.origin,
              nowIso,
              originCheck.boundaryVersion,
            ),
            snapshotRow(
              referenceSnapshotId,
              shipmentId,
              "delivery_reference",
              request.destination,
              nowIso,
              destinationCheck.boundaryVersion,
            ),
          ])
          .run();

        const result = tx
          .insert(shipments)
          .values({
            shipmentId,
            idempotencyKey,
            requestHash,
            originSnapshotId,
            referenceSnapshotId,
            originDepot: route.originDepot.label,
            destinationDepot: route.destinationDepot.label,
            local: route.local,
            declaredValueSen: request.declaredValueSen,
            codAmountSen: request.codAmountSen ?? 0,
            recipientChannel: request.recipientChannel,
            recipientName: request.recipientName ?? null,
            createdAt: nowIso,
          })
          .onConflictDoNothing({ target: shipments.idempotencyKey })
          .run();

        // Lost the key: roll back so the two snapshots go with it.
        if (result.changes === 0) tx.rollback();
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }

  const existing = db.select().from(shipments).where(eq(shipments.idempotencyKey, idempotencyKey)).get();
  if (!existing) throw new Error(`idempotency key ${idempotencyKey} neither inserted nor found`);

  if (existing.shipmentId === shipmentId) return { status: "created", shipment: existing };
  if (existing.requestHash === requestHash) return { status: "replayed", shipment: existing };
  return {
    status: "conflict",
    reason:
      "This idempotency key was already used for a different shipment. Nothing was created; " +
      "use a new key for a new shipment.",
  };
}

function snapshotRow(
  snapshotId: string,
  shipmentId: string,
  purpose: LocationSnapshot["purpose"],
  location: LocationInput,
  nowIso: string,
  boundaryVersion: string,
) {
  return {
    snapshotId,
    shipmentId,
    purpose,
    latitude: location.latitude,
    longitude: location.longitude,
    addressClaim: location.addressClaim?.trim() ?? "",
    resolvedLabel: location.resolved?.label ?? null,
    resolvedBy: location.resolved?.by ?? null,
    resolvedRef: location.resolved?.ref ?? null,
    source: "map_confirmed" as const,
    confirmedAt: nowIso,
    boundaryVersion,
  };
}

export type CorrectionResult =
  { ok: true; correction: CorrectionRow; to: LocationSnapshot } | { ok: false; code: string; reason: string };

/**
 * Append a correction. The original reference is untouched; the new point is a
 * new snapshot, and a row records the move from the current point to it.
 *
 * NOTHING HERE TELLS THE ENGINE. The stale-record behaviour stays exactly as
 * session 20 built it: the delivery reference the engine compares against is
 * the one on the parcel, and a correction reaching the courier does not reach
 * the registry. Whether a correction may still be made (not after delivery) is
 * workflow state, which is the caller's to enforce.
 */
export function appendCorrection(
  db: VigilDb,
  input: {
    shipmentId: string;
    to: LocationInput;
    boundary: ServiceBoundary | null;
    nowIso: string;
  },
): CorrectionResult {
  const check = checkPoint(input.to, input.boundary);
  if (!check.ok) return { ok: false, code: check.code, reason: check.reason };

  return db.transaction(
    (tx) => {
      const shipment = tx.select().from(shipments).where(eq(shipments.shipmentId, input.shipmentId)).get();
      if (!shipment)
        return {
          ok: false as const,
          code: "not_found",
          reason: "No shipment under that reference.",
        };

      const history = tx
        .select()
        .from(locationCorrections)
        .where(eq(locationCorrections.shipmentId, input.shipmentId))
        .orderBy(asc(locationCorrections.sequence))
        .all();
      const fromSnapshotId = history.at(-1)?.toSnapshotId ?? shipment.referenceSnapshotId;

      const toSnapshotId = randomUUID();
      const toRow = snapshotRow(
        toSnapshotId,
        input.shipmentId,
        "delivery_reference",
        input.to,
        input.nowIso,
        check.boundaryVersion,
      );
      tx.insert(locationSnapshots).values(toRow).run();

      const correction = {
        correctionId: randomUUID(),
        shipmentId: input.shipmentId,
        sequence: history.length + 1,
        fromSnapshotId,
        toSnapshotId,
        correctedAt: input.nowIso,
      };
      tx.insert(locationCorrections).values(correction).run();
      return { ok: true as const, correction, to: toRow };
    },
    { behavior: "immediate" },
  );
}

/** The simulated courier's position, recorded as what it is: a simulation input, not a reference. */
export function recordSimulatedScan(
  db: VigilDb,
  input: { shipmentId: string; point: Point; nowIso: string },
): LocationSnapshot {
  const row = {
    snapshotId: randomUUID(),
    shipmentId: input.shipmentId,
    purpose: "simulated_scan" as const,
    latitude: input.point.latitude,
    longitude: input.point.longitude,
    addressClaim: "(simulated courier position — not a claimed address)",
    resolvedLabel: null,
    resolvedBy: null,
    resolvedRef: null,
    source: "simulation" as const,
    confirmedAt: input.nowIso,
    boundaryVersion: "unchecked",
  };
  db.insert(locationSnapshots).values(row).run();
  return row;
}

export type ShipmentHistory = {
  shipment: ShipmentRow;
  origin: LocationSnapshot;
  /** The reference as first confirmed. Never changes. */
  originalReference: LocationSnapshot;
  /** The latest point the courier has been told about; equals the original with no corrections. */
  currentReference: LocationSnapshot;
  corrections: Array<CorrectionRow & { from: LocationSnapshot; to: LocationSnapshot }>;
};

export function getShipment(db: VigilDb, shipmentId: string): ShipmentHistory | undefined {
  const shipment = db.select().from(shipments).where(eq(shipments.shipmentId, shipmentId)).get();
  if (!shipment) return undefined;

  const snapshots = new Map(
    db
      .select()
      .from(locationSnapshots)
      .where(eq(locationSnapshots.shipmentId, shipmentId))
      .all()
      .map((row) => [row.snapshotId, row]),
  );
  const need = (id: string) => {
    const row = snapshots.get(id);
    if (!row) throw new Error(`snapshot ${id} referenced by shipment ${shipmentId} is missing`);
    return row;
  };

  const corrections = db
    .select()
    .from(locationCorrections)
    .where(eq(locationCorrections.shipmentId, shipmentId))
    .orderBy(asc(locationCorrections.sequence))
    .all()
    .map((row) => ({
      ...row,
      from: need(row.fromSnapshotId),
      to: need(row.toSnapshotId),
    }));

  const originalReference = need(shipment.referenceSnapshotId);
  return {
    shipment,
    origin: need(shipment.originSnapshotId),
    originalReference,
    currentReference: corrections.at(-1)?.to ?? originalReference,
    corrections,
  };
}

export function listShipments(db: VigilDb): ShipmentRow[] {
  return db.select().from(shipments).orderBy(asc(shipments.createdAt)).all();
}

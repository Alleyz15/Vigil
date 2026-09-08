import { randomUUID } from "node:crypto";
import type { VigilDb } from "@/lib/db/client";
import { events, verdicts } from "@/lib/db/schema";
import { type EpcisEvent, epcsOf } from "@/lib/epcis";
import { canonicalHash } from "@/lib/ledger/canonical";
import type { Verdict } from "@/lib/ledger/types";

/**
 * Write the operator console's projection of a sealed handoff.
 *
 * THE LEDGER IS WRITTEN FIRST, always. These rows are a queryable view of what
 * the append-only chain already holds; if the two ever disagree, the ledger
 * wins. Persisting here rather than in lib/ledger keeps that ordering visible.
 *
 * Also what makes axis 2 possible at all: P1-P5 read a courier's PAST handoffs
 * and their stored axis-1 scores, so an event that is never projected is an
 * event no future pattern can see.
 */

/** Store the event verbatim, plus the columns the window queries index on. */
export function persistEvent(db: VigilDb, event: EpcisEvent, courierId?: string): void {
  const payloadJson = JSON.stringify(event);

  db.insert(events)
    .values({
      eventId: event.eventID,
      type: event.type,
      eventTime: event.eventTime,
      // parse stamps this before the engine ever runs; the fallback is defensive.
      recordTime: event.recordTime ?? event.eventTime,
      eventTimeZoneOffset: event.eventTimeZoneOffset,
      readPoint: event.readPoint?.id,
      bizLocation: event.bizLocation?.id,
      bizStep: event.bizStep,
      disposition: event.disposition,
      courierId: courierId ?? null,
      primaryEpc: epcsOf(event)[0] ?? null,
      payloadJson,
      // The same value the ledger bound this eventID to.
      payloadHash: canonicalHash(event),
    })
    // A duplicate reaches the ledger's NO-OP path before it reaches here, so an
    // existing row means the same event, already stored. Nothing to update.
    .onConflictDoNothing()
    .run();
}

export function persistVerdict(
  db: VigilDb,
  eventId: string,
  ledgerSeq: number,
  verdict: Verdict,
): void {
  db.insert(verdicts)
    .values({
      verdictId: randomUUID(),
      eventId,
      ledgerSeq,
      decision: verdict.decision,
      // Two separate columns. Never summed; see CLAUDE.md.
      inconsistencyScore: verdict.inconsistencyScore,
      patternScore: verdict.patternScore,
      flagsJson: JSON.stringify(verdict.flags),
      abortCode: verdict.abortCode,
      basis: verdict.basis,
      requiresCosign: verdict.requiresCosign,
    })
    .onConflictDoNothing()
    .run();
}

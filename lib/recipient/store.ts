import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { VigilDb } from "@/lib/db/client";
import { disputes, recipientConfirmations } from "@/lib/db/schema";
import {
  evaluateToken,
  type ConfirmationRow,
  type RecipientAnswer,
  type TokenState,
} from "./token";

/**
 * Reads and writes for the recipient capability.
 *
 * I/O lives here, deliberately outside the purity guard, exactly like
 * `lib/assemble`. The decision about whether a token may be answered is pure
 * and lives in `token.ts`; this module only performs what that decision allows.
 */

export type IssueArgs = {
  eventId: string;
  epc: string;
  channelFingerprint: string;
  issuedAt: string;
  /** How long the recipient has to answer. */
  windowHours: number;
};

/** Issue one capability for one delivered handoff. Idempotent per event. */
export function issueConfirmation(db: VigilDb, args: IssueArgs): string {
  const existing = db
    .select({ tokenId: recipientConfirmations.tokenId })
    .from(recipientConfirmations)
    .where(eq(recipientConfirmations.eventId, args.eventId))
    .get();
  if (existing) return existing.tokenId;

  // The token IS the credential, so it must not be derivable from the parcel,
  // the event id, or anything else a courier can see. Deliberately not seeded:
  // a reproducible capability is a guessable one.
  const tokenId = randomUUID();
  const expiresAt = new Date(Date.parse(args.issuedAt) + args.windowHours * 3_600_000).toISOString();

  db.insert(recipientConfirmations)
    .values({
      tokenId,
      eventId: args.eventId,
      epc: args.epc,
      channelFingerprint: args.channelFingerprint,
      issuedAt: args.issuedAt,
      expiresAt,
      answeredAt: null,
      answer: null,
    })
    .run();

  return tokenId;
}

export function readConfirmation(db: VigilDb, tokenId: string): ConfirmationRow | undefined {
  const row = db
    .select()
    .from(recipientConfirmations)
    .where(eq(recipientConfirmations.tokenId, tokenId))
    .get();
  return row ? toRow(row) : undefined;
}

export function tokenStateOf(db: VigilDb, tokenId: string, nowIso: string): TokenState {
  return evaluateToken(readConfirmation(db, tokenId), nowIso);
}

export type AnswerResult =
  | { ok: true; state: TokenState; disputeId: string | null }
  | { ok: false; state: TokenState };

/**
 * Record the recipient's answer.
 *
 * "I did not receive it" writes into the SAME `disputes` table P2 already
 * reads. That is the whole point of this route: `assemblePatternInput` joins
 * disputes to events by event id, so a recipient's answer becomes pattern
 * evidence about that courier without anything special being wired up for it.
 * A parallel "recipient disputes" table would have left P2 reading generator
 * output forever.
 *
 * "I received it" writes only the confirmation row. Putting a positive into
 * `disputes` would corrupt the numerator AND the fleet baseline, which is
 * computed from that table.
 */
export function answerConfirmation(
  db: VigilDb,
  tokenId: string,
  answer: RecipientAnswer,
  nowIso: string,
): AnswerResult {
  const state = tokenStateOf(db, tokenId, nowIso);
  // Expired, already answered, or unknown: the capability is spent or was
  // never valid. Nothing is written, including no partial record of the
  // attempt — an expired link must not become a back door to a second answer.
  if (state.status !== "open") return { ok: false, state };

  const row = state.row;

  db.transaction((tx) => {
    tx.update(recipientConfirmations)
      .set({ answer, answeredAt: nowIso })
      .where(eq(recipientConfirmations.tokenId, tokenId))
      .run();

    if (answer === "not_received") {
      tx.insert(disputes)
        .values({
          disputeId: `dsp-${row.eventId}`,
          eventId: row.eventId,
          epc: row.epc,
          raisedAt: nowIso,
          kind: "not_received",
          notes: "Recipient answered the confirmation link.",
        })
        .onConflictDoNothing()
        .run();
    }
  });

  return {
    ok: true,
    state: tokenStateOf(db, tokenId, nowIso),
    disputeId: answer === "not_received" ? `dsp-${row.eventId}` : null,
  };
}

/**
 * Close out every capability whose window has passed without an answer.
 *
 * SILENCE IS RECORDED, NOT INFERRED. A recipient who never replies is a weak
 * signal in its own right, and leaving the row blank would make "not asked"
 * and "asked, no reply" indistinguishable — the same two-state collapse rule 4f
 * bans elsewhere.
 *
 * IT IS NOT A DISPUTE. Nothing here writes to `disputes`: treating silence as
 * a complaint would put words in a recipient's mouth and inflate P2 with
 * people who were on holiday. Nothing scores `no_response` at all today; see
 * Known Limitations.
 */
export function expireConfirmations(db: VigilDb, nowIso: string): number {
  const stale = db
    .select({ tokenId: recipientConfirmations.tokenId })
    .from(recipientConfirmations)
    .where(and(isNull(recipientConfirmations.answer), lt(recipientConfirmations.expiresAt, nowIso)))
    .all();

  for (const { tokenId } of stale) {
    db.update(recipientConfirmations)
      .set({ answer: "no_response", answeredAt: nowIso })
      .where(eq(recipientConfirmations.tokenId, tokenId))
      .run();
  }

  return stale.length;
}

function toRow(row: typeof recipientConfirmations.$inferSelect): ConfirmationRow {
  return {
    tokenId: row.tokenId,
    eventId: row.eventId,
    epc: row.epc,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    answeredAt: row.answeredAt,
    answer: row.answer,
  };
}

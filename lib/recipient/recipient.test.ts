import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createMigratedDb } from "@/lib/db/migrate";
import { couriers, disputes, events, parcels, verdicts } from "@/lib/db/schema";
import { assemblePatternInput } from "@/lib/assemble/pattern-input";
import { closeDb, type VigilDb } from "@/lib/db/client";
import type { ConfirmationRow, TokenState } from "./index";
import {
  answerConfirmation,
  evaluateToken,
  expireConfirmations,
  issueConfirmation,
  readConfirmation,
  remainingLabel,
  tokenStateOf,
} from "./index";

/**
 * The recipient capability, and the loop it closes.
 *
 * E1 measured that a careful fraudster defeats every single-event check and is
 * caught by P2 — the customer complaint — after about ten deliveries. That made
 * P2 the strongest signal in the system and also the one whose input appeared
 * from nowhere: the generator wrote disputes directly. The load-bearing test in
 * this file is the last one, which proves a dispute created through the
 * recipient's own link is the same data `assemblePatternInput` reads. Without
 * it the loop is closed only on screen.
 */

const NOW = "2026-09-08T12:00:00.000Z";
const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const EPC = "urn:epc:id:sgtin:0614141.100000.1";
const COURIER = "CR-1001";

const open: VigilDb[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (open.length) closeDb(open.pop()!);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A minimal world: one parcel, one sealed delivery, one verdict. */
function seed(): VigilDb {
  const db = createMigratedDb(":memory:");
  open.push(db);

  db.insert(couriers)
    .values({ courierId: COURIER, displayName: "Test Courier", publicKey: "key" })
    .run();

  db.insert(parcels)
    .values({
      epc: EPC,
      waybillNo: "WB-TEST-1",
      recipientName: "Test Recipient",
      recipientPhone: "+60123456789",
      recipientAddress: "Somewhere",
      recipientLat: 3.1,
      recipientLng: 101.7,
      declaredValueSen: 5000,
      codAmountSen: 0,
    })
    .run();

  db.insert(events)
    .values({
      eventId: EVENT_ID,
      type: "ObjectEvent",
      primaryEpc: EPC,
      courierId: COURIER,
      bizStep: "urn:epcglobal:cbv:bizstep:delivering",
      eventTime: "2026-09-08T10:00:00.000Z",
      recordTime: "2026-09-08T10:00:30.000Z",
      eventTimeZoneOffset: "+08:00",
      payloadJson: JSON.stringify({}),
      payloadHash: "0".repeat(64),
    })
    .run();

  db.insert(verdicts)
    .values({
      verdictId: "v-1",
      eventId: EVENT_ID,
      ledgerSeq: 0,
      decision: "accept",
      inconsistencyScore: 0,
      patternScore: 0,
      flagsJson: "[]",
      basis: "both_axes",
      requiresCosign: false,
    })
    .run();

  return db;
}

function issue(db: VigilDb, windowHours = 48): string {
  return issueConfirmation(db, {
    eventId: EVENT_ID,
    epc: EPC,
    channelFingerprint: "fingerprint",
    issuedAt: "2026-09-08T10:00:30.000Z",
    windowHours,
  });
}

describe("the token is a scoped capability", () => {
  it("issues one token per handoff and returns the same one twice", () => {
    const db = seed();
    expect(issue(db)).toBe(issue(db));
  });

  it("refuses an EXPIRED token and writes nothing", () => {
    const db = seed();
    // A one-hour window, answered three hours later.
    const token = issue(db, 1);
    const before = db.select().from(disputes).all();

    const result = answerConfirmation(db, token, "not_received", "2026-09-08T13:00:30.000Z");

    expect(result.ok).toBe(false);
    expect(result.state.status).toBe("expired");
    expect(db.select().from(disputes).all()).toEqual(before);
    expect(readConfirmation(db, token)?.answer).toBeNull();
  });

  it("refuses a REUSED token, keeping the first answer", () => {
    const db = seed();
    const token = issue(db);

    const first = answerConfirmation(db, token, "received", NOW);
    const second = answerConfirmation(db, token, "not_received", NOW);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.state.status).toBe("answered");
    // The second answer must not overwrite the first, and must not raise a
    // dispute the recipient's real answer did not support.
    expect(readConfirmation(db, token)?.answer).toBe("received");
    expect(db.select().from(disputes).all()).toHaveLength(0);
  });

  it("refuses an unknown token", () => {
    const db = seed();
    expect(tokenStateOf(db, "not-a-token", NOW).status).toBe("unknown");
    expect(answerConfirmation(db, "not-a-token", "received", NOW).ok).toBe(false);
  });

  /** Answered beats expired: an answer recorded in time is not lost to the clock. */
  it("reports an answered token as answered even after its window closes", () => {
    const state = evaluateToken(
      {
        tokenId: "t",
        eventId: EVENT_ID,
        epc: EPC,
        issuedAt: "2026-09-08T10:00:00.000Z",
        expiresAt: "2026-09-08T11:00:00.000Z",
        answeredAt: "2026-09-08T10:30:00.000Z",
        answer: "received",
      },
      "2026-09-09T00:00:00.000Z",
    );

    expect(state.status).toBe("answered");
  });
});

describe("the time remaining is measured against the clock that judged the token", () => {
  // Annotated, not `as const`: the annotation is what makes tsc complain if the
  // row shape moves under this fixture. An untyped literal compiles happily
  // against a type it no longer satisfies.
  const row: ConfirmationRow = {
    tokenId: "t",
    eventId: EVENT_ID,
    epc: EPC,
    issuedAt: NOW,
    expiresAt: "2026-09-08T18:00:00.000Z",
    answer: null,
    answeredAt: null,
  };
  const openState: TokenState = { status: "open", row };

  it("reports hours left from the instant the status was decided", () => {
    expect(remainingLabel(openState, NOW)).toBe("6 hours");
  });

  it("rounds sub-hour windows to minutes, never to zero, and counts in English", () => {
    expect(remainingLabel(openState, "2026-09-08T17:30:00.000Z")).toBe("30 minutes");
    expect(remainingLabel(openState, "2026-09-08T17:59:59.000Z")).toBe("1 minute");
  });

  /**
   * THE REGRESSION. The page used to compute this from `Date.now()` while the
   * status came from the workbench's seeded clock. Those are days apart in the
   * demo, so an open token produced a negative remainder and the identity strip
   * silently fell back to a generic label — no error, no failing test, just a
   * surface that stopped saying anything specific.
   */
  it("would go silent if measured against a clock that did not judge it", () => {
    const wallClock = "2026-09-12T00:00:00.000Z";
    expect(remainingLabel(openState, wallClock)).toBeNull();
    expect(remainingLabel(openState, NOW)).toBe("6 hours");
  });

  it("says 1 day rather than 1 days", () => {
    expect(remainingLabel(openState, "2026-09-07T17:00:00.000Z")).toBe("1 day");
    expect(remainingLabel(openState, "2026-09-06T17:00:00.000Z")).toBe("2 days");
    expect(remainingLabel(openState, "2026-09-08T17:00:00.000Z")).toBe("1 hour");
  });

  it("offers no duration for a token that is not open", () => {
    expect(remainingLabel({ status: "unknown" }, NOW)).toBeNull();
    expect(remainingLabel({ status: "expired", row }, NOW)).toBeNull();
  });
});

describe("the three outcomes are recorded differently", () => {
  it("records a positive confirmation WITHOUT touching disputes", () => {
    const db = seed();
    const token = issue(db);

    const result = answerConfirmation(db, token, "received", NOW);

    expect(result.ok && result.disputeId).toBeNull();
    expect(readConfirmation(db, token)?.answer).toBe("received");
    // P2's numerator and the fleet baseline are both computed from this table.
    // A confirmation stored here would inflate every courier's rate.
    expect(db.select().from(disputes).all()).toHaveLength(0);
  });

  it("records silence as silence, and never as a complaint", () => {
    const db = seed();
    const token = issue(db, 1);

    const closed = expireConfirmations(db, "2026-09-08T13:00:30.000Z");

    expect(closed).toBe(1);
    expect(readConfirmation(db, token)?.answer).toBe("no_response");
    // Treating silence as a complaint would put words in a recipient's mouth
    // and inflate P2 with people who were simply away.
    expect(db.select().from(disputes).all()).toHaveLength(0);
  });

  it("leaves an already-answered token alone when the window passes", () => {
    const db = seed();
    const token = issue(db, 1);
    answerConfirmation(db, token, "received", "2026-09-08T10:30:00.000Z");

    expect(expireConfirmations(db, "2026-09-08T13:00:30.000Z")).toBe(0);
    expect(readConfirmation(db, token)?.answer).toBe("received");
  });
});

/**
 * THE LOOP, CLOSED IN DATA RATHER THAN ON SCREEN.
 *
 * P2 is the strongest signal in the system and its input has always been
 * generator output. This asserts that a dispute raised by a recipient through
 * their own link is picked up by the same assembler that feeds the pattern
 * axis — same table, same join, no special wiring.
 */
describe("a recipient's answer becomes pattern evidence", () => {
  it("writes a dispute that assemblePatternInput reads", () => {
    const db = seed();
    const token = issue(db);

    const before = assemblePatternInput(db, COURIER, NOW);
    expect(before.input.handoffs).toHaveLength(1);
    expect(before.input.handoffs[0].disputed).toBe(false);

    const result = answerConfirmation(db, token, "not_received", NOW);
    expect(result.ok && result.disputeId).toBe(`dsp-${EVENT_ID}`);

    const after = assemblePatternInput(db, COURIER, NOW);
    expect(after.input.handoffs).toHaveLength(1);
    expect(after.input.handoffs[0].disputed).toBe(true);
    expect(after.input.handoffs[0].eventID).toBe(EVENT_ID);
  });

  it("stores it in the same table and shape the generator writes", () => {
    const db = seed();
    answerConfirmation(db, issue(db), "not_received", NOW);

    const row = db.select().from(disputes).where(eq(disputes.eventId, EVENT_ID)).get();
    expect(row).toMatchObject({ eventId: EVENT_ID, epc: EPC, kind: "not_received" });
  });
});

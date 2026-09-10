import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verdicts } from "@/lib/db/schema";
import { createWorkbench, type OperatorWorkbench } from "./service";
import { courierOutcome } from "./courier";
import type { RunView } from "./read-model";

/**
 * The courier side of the two-phase co-sign, end to end.
 *
 * The claim this file exists to keep true is rule 3c's: because the credential
 * is a SIDECAR, the co-signed resubmission is the SAME BYTES under the same
 * event id, so the ledger records it as a first sighting rather than aborting
 * it as EVENT_ID_REUSE. If the credential ever moved inside the EPCIS event,
 * co-signing would freeze the courier for co-signing, and this is the test that
 * would say so.
 */
describe("courier submission", () => {
  let workbench: OperatorWorkbench;

  beforeAll(async () => {
    workbench = await createWorkbench({ scenarioIds: ["S4"] });
  }, 60_000);

  afterAll(() => workbench.close());

  function draft(scenarioId: "S0" | "S1") {
    const found = workbench.listCourierDrafts().find((d) => d.scenarioId === scenarioId);
    if (!found) throw new Error(`no ${scenarioId} draft`);
    return found;
  }

  it("holds back a genuinely unsubmitted final leg for the courier", () => {
    const drafts = workbench.listCourierDrafts();
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => d.attempts.length === 0)).toBe(true);
    // Nothing is in the operator's queue for these event ids yet.
    const queued = new Set(workbench.listQueue().map((item) => item.eventId));
    expect(drafts.some((d) => queued.has(d.eventId))).toBe(false);
  });

  /**
   * SESSION 16'S CONSTITUTIVE CASE. An absent courier signature is not a
   * refusal — it decides nothing and writes nothing. Asserted on ordinary work
   * so the result cannot be confused with the risk level demanding something.
   */
  it("halts an unsigned handoff as PENDING_COURIER_SIGNATURE and seals nothing", async () => {
    const target = draft("S0");
    const { db } = workbench.debugDraftHandle(target.draftId);
    const before = db.select().from(verdicts).all();

    const { run, outcome } = await workbench.submitAsCourier(target.draftId, { signed: false });

    expect(run.halted).toMatchObject({ reason: "PENDING_COURIER_SIGNATURE" });
    expect(run.sealed).toBe(false);
    expect(run.ledgerStatus).toBeNull();
    expect(outcome.kind).toBe("signature_missing");
    expect(db.select().from(verdicts).all()).toEqual(before);

    // Nobody is waiting on an operator, so it must not enter the work queue.
    expect(workbench.listQueue().some((item) => item.eventId === target.eventId)).toBe(false);
  });

  it("seals ordinary work on the courier signature alone", async () => {
    const { run, outcome } = await workbench.submitAsCourier(draft("S0").draftId, { signed: true });

    expect(run.credential).toMatchObject({ courierValid: true, cosignRequired: false });
    expect(run.ledgerStatus).toBe("recorded");
    expect(outcome.kind).toBe("sealed");
  });

  /**
   * "Signature valid, but insufficient" — the wording matters, and so does the
   * fact that it is DERIVED. The courier's signature verifies; what is missing
   * is the operator's. Describing that as a rejection would describe a
   * different system.
   */
  it("reports a courier-only credential as valid but insufficient, sealing nothing", async () => {
    const target = draft("S1");
    const { db } = workbench.debugDraftHandle(target.draftId);
    const before = db.select().from(verdicts).all();

    const { run, outcome } = await workbench.submitAsCourier(target.draftId, { signed: true });

    expect(run.credential).toMatchObject({
      courierValid: true,
      operatorValid: false,
      cosignRequired: true,
      valid: false,
    });
    expect(run.halted).toMatchObject({ reason: "PENDING_COSIGNATURE" });
    expect(run.sealed).toBe(false);
    expect(db.select().from(verdicts).all()).toEqual(before);

    expect(outcome.kind).toBe("signature_insufficient");
    expect(outcome.headline).toBe("Signature valid, but insufficient");
    expect(outcome.detail).toMatch(/cannot be verified without an operator signature/);
    // The verifier's own words, not only our summary of them.
    expect(outcome.problems.join(" ")).toMatch(/operator/);

    // NOW the operator has something to do.
    expect(workbench.listQueue().some((item) => item.eventId === target.eventId)).toBe(true);
  });

  /**
   * THE SIDECAR CLAIM, asserted rather than described.
   *
   * The operator completes the credential and the identical event runs again.
   * It must seal as a first sighting. An EVENT_ID_REUSE abort here would mean
   * the credential had leaked into the payload.
   */
  it("seals the co-signed resubmission as a first sighting, not EVENT_ID_REUSE", async () => {
    const target = draft("S1");
    const detail = await workbench.resolveHandoff(target.eventId, { action: "approve" });

    expect(detail.runs).toHaveLength(2);
    expect(detail.runs[0].eventHash).toBe(detail.runs[1].eventHash);
    expect(detail.runs[1].ledgerStatus).toBe("recorded");
    expect(detail.runs[1].ledgerStatus).not.toBe("aborted");
    expect(detail.summary.sealed).toBe(true);
  });

  /**
   * The honest double-tap, which has existed since session 1 and has never been
   * visible anywhere. A courier retrying the same bytes after sealing must get
   * the original verdict back as a NO-OP — never a forgery alert aimed at a
   * person. Rule 5.
   */
  it("treats a courier retry after sealing as a NO-OP replay, not a reused id", async () => {
    const target = draft("S1");
    const { run, outcome } = await workbench.submitAsCourier(target.draftId, { signed: true });

    expect(run.ledgerStatus).toBe("noop");
    expect(outcome.kind).toBe("replay_noop");
    expect(outcome.headline).toMatch(/already recorded/i);
    expect(outcome.detail).toMatch(/twice is not a problem/i);
  });

  it("records every attempt against the draft, oldest first", () => {
    const s1 = draft("S1");
    expect(s1.attempts.map((attempt) => attempt.outcome.kind)).toEqual([
      "signature_insufficient",
      "replay_noop",
    ]);
    expect(draft("S0").attempts.map((attempt) => attempt.outcome.kind)).toEqual([
      "signature_missing",
      "sealed",
    ]);
  });
});

/**
 * The outcome text is a pure function of what happened, so it is tested without
 * a workbench. A reused id and a no-op replay are the pair that must never
 * collapse into one message.
 */
describe("courier outcome wording", () => {
  const base: RunView = {
    run: 1,
    eventHash: "hash",
    decision: null,
    halted: null,
    sealed: false,
    ledgerStatus: null,
    credential: null,
    trace: [],
  };

  it("separates a reused event id from an honest retry", () => {
    const reused = courierOutcome({ ...base, ledgerStatus: "aborted" });
    const retry = courierOutcome({ ...base, ledgerStatus: "noop", sealed: true });

    expect(reused.kind).toBe("replay_reused_id");
    expect(retry.kind).toBe("replay_noop");
    expect(reused.headline).not.toBe(retry.headline);
    expect(reused.sealed).toBe(false);
    expect(retry.sealed).toBe(true);
  });

  it("never describes a missing co-signature as a rejection", () => {
    const outcome = courierOutcome({
      ...base,
      halted: { at: "gate", reason: "PENDING_COSIGNATURE" },
      credential: {
        valid: false,
        courierValid: true,
        operatorValid: false,
        cosignRequired: true,
        problems: ["operator: no operator signature was presented"],
      },
    });

    expect(outcome.kind).toBe("signature_insufficient");
    expect(`${outcome.headline} ${outcome.detail}`.toLowerCase()).not.toMatch(
      /reject|refus|denied|not allowed/,
    );
  });
});

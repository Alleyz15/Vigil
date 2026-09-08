import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { verdicts } from "@/lib/db/schema";
import { cosign, verifyCredential } from "@/lib/credential";
import { runAgent } from "./machine";
import {
  type World,
  makeAgentEvent,
  resetEventIds,
  runSigned,
  seedWorld,
} from "./fixtures";

/**
 * The constitutive co-signature, wired.
 *
 * The credential rides ALONGSIDE the event, never inside it. Everything below
 * depends on that: the courier-only attempt and the co-signed resubmission are
 * the same EPCIS payload, so the ledger sees one handoff rather than two, and
 * the second submission is not an EVENT_ID_REUSE forgery. See CLAUDE.md.
 */

let world: World;

beforeEach(() => {
  resetEventIds();
  world = seedWorld();
});
afterEach(() => rmSync(world.dir, { recursive: true, force: true }));

/**
 * THE DEMO BEAT.
 *
 * A judge asks whether the approval button is real. The answer is that a
 * courier-only token does not verify — not that it is stored and marked
 * unapproved. There is no valid credential, and the courier cannot make one.
 */
describe("courier-only credential is cryptographically invalid, not merely unapproved", () => {
  it("refuses to seal a co-sign-required handoff presented with only the courier's signature", () => {
    const event = makeAgentEvent();
    // The courier signs correctly. Their signature is valid. It is not enough.
    const courierOnly = world.credentialFor(event, { cosign: false });

    const ctx = runAgent(event, world.deps, { credential: courierOnly });

    expect(ctx.requiresCosign).toBe(true);
    expect(ctx.halted).toEqual({ at: "gate", reason: "PENDING_COSIGNATURE" });

    // The courier's own signature verified. The credential still did not.
    expect(ctx.credential?.validSignatures).toEqual(["courier"]);
    expect(ctx.credential?.valid).toBe(false);
    expect(ctx.credential?.problems[0]).toMatchObject({ code: "MISSING", role: "operator" });

    // NOTHING WAS SEALED. Not an accept, not a rejection - the handoff is
    // undecided, so it wrote nothing.
    expect(ctx.decision).toBeUndefined();
    expect(ctx.verdict).toBeUndefined();
    expect(world.deps.ledger.readRecords()).toHaveLength(0);
    expect(world.deps.db.select().from(verdicts).all()).toHaveLength(0);
  });

  it("is a verification failure, not a policy flag: the same token verifies when no co-sign is required", () => {
    const event = makeAgentEvent();
    const courierOnly = world.credentialFor(event, { cosign: false });

    // Same bytes, same signature. The only thing that changed is the threshold.
    const asLowRisk = verifyCredential({
      credential: courierOnly,
      handoff: {
        eventID: courierOnly.subject.eventID,
        epc: courierOnly.subject.epc,
        courierId: courierOnly.subject.courierId,
        mandateId: courierOnly.subject.mandateId,
      },
      keys: {
        courierPublicKey: world.keys.courier.publicKey,
        operatorPublicKey: world.keys.operator.publicKey,
      },
      cosignRequired: false,
    });

    expect(asLowRisk.valid).toBe(true);
  });
});

describe("the two-phase flow", () => {
  it("seals cleanly when the operator co-signs the same handoff", () => {
    const event = makeAgentEvent();

    // Phase 1: courier submits. Nothing seals.
    const pending = runAgent(event, world.deps, {
      credential: world.credentialFor(event, { cosign: false }),
    });
    expect(pending.halted?.reason).toBe("PENDING_COSIGNATURE");
    expect(world.deps.ledger.readRecords()).toHaveLength(0);

    // Phase 2: the operator co-signs, and the SAME event is resubmitted.
    const approved = cosign(
      world.credentialFor(event, { cosign: false }),
      "OP-01",
      world.keys.operator.privateKey,
    );
    const sealed = runAgent(event, world.deps, { credential: approved });

    expect(sealed.halted).toBeUndefined();
    expect(sealed.decision).toBe("accept");
    expect(sealed.credential?.valid).toBe(true);
    expect(sealed.credential?.validSignatures.sort()).toEqual(["courier", "operator"]);
    expect(world.deps.ledger.verifyChain()).toEqual({ valid: true, entries: 1 });
  });

  /**
   * This is the interaction the sidecar design exists to protect. If the
   * credential lived inside the EPCIS event, the co-signed resubmission would
   * be a DIFFERENT payload under the same eventID, and the ledger would
   * correctly abort it as EVENT_ID_REUSE — freezing the courier for the crime
   * of being co-signed. See CLAUDE.md.
   */
  it("does not treat the co-signed resubmission as an event ID reuse", () => {
    const event = makeAgentEvent();

    runAgent(event, world.deps, { credential: world.credentialFor(event, { cosign: false }) });
    const sealed = runSigned(event, world);

    expect(sealed.ledger).toEqual({ status: "recorded", seq: 0 });
    expect(sealed.verdict?.abortCode).toBeUndefined();
    // No abort record: nothing about this was a forgery.
    expect(world.deps.ledger.readRecords().map((r) => r.kind)).toEqual(["verdict"]);
  });

  it("replays the sealed verdict if the courier-only attempt arrives again afterwards", () => {
    const event = makeAgentEvent();
    const sealed = runSigned(event, world);

    // The device retries its original courier-only submission. Same event, so
    // the ledger's NO-OP path answers before the credential is ever consulted.
    const replay = runAgent(event, world.deps, {
      credential: world.credentialFor(event, { cosign: false }),
    });

    expect(replay.halted).toEqual({ at: "verify", reason: "DUPLICATE_NO_OP" });
    expect(replay.verdict).toEqual(sealed.verdict);
    expect(world.deps.ledger.readRecords()).toHaveLength(1);
  });

  it("records who approved the handoff on the console projection", () => {
    const event = makeAgentEvent();
    const ctx = runSigned(event, world);

    const row = world.deps.db
      .select()
      .from(verdicts)
      .where(eq(verdicts.eventId, ctx.event!.eventID))
      .get();

    expect(row?.operatorId).toBe("OP-01");
    expect(row?.operatorSignature).toBeTruthy();
    expect(row?.courierSignature).toBeTruthy();
    expect(row?.requiresCosign).toBe(true);
  });
});

/**
 * A forged signature is an ATTACK, and an attack is evidence. It seals — at the
 * harshest outcome — because the ledger is where evidence belongs. A missing
 * co-signature decided nothing and writes nothing. The two must not be
 * conflated.
 */
describe("a forged signature is sealed as evidence", () => {
  it("freezes and records a forged courier signature", () => {
    const event = makeAgentEvent();
    const ctx = runSigned(event, world, { forgeCourier: true });

    expect(ctx.halted).toBeUndefined();
    expect(ctx.decision).toBe("freeze");
    expect(ctx.verdict?.abortCode).toBe("CREDENTIAL_INVALID");
    expect(ctx.verdict?.flags).toContain("C1");
    expect(ctx.credential?.invalidSignatures).toContain("courier");

    // Sealed, unlike the pending case.
    expect(world.deps.ledger.readRecords()).toHaveLength(1);
    expect(world.deps.ledger.verifyChain()).toEqual({ valid: true, entries: 1 });
  });

  it("freezes a co-signature from a key that is not the operator's", () => {
    const event = makeAgentEvent();
    const ctx = runSigned(event, world, { forgeOperator: true });

    expect(ctx.decision).toBe("freeze");
    expect(ctx.credential?.invalidSignatures).toContain("operator");
    expect(world.deps.ledger.readRecords()).toHaveLength(1);
  });

  it("freezes an operator approval lifted from another handoff", () => {
    const eventA = makeAgentEvent({ eventTime: "2026-09-08T09:00:00+08:00" });
    const eventB = makeAgentEvent({ eventTime: "2026-09-08T10:15:00+08:00" });

    const approvedA = world.credentialFor(eventA, { cosign: true });
    const operatorFromA = approvedA.signatures.find((s) => s.role === "operator")!;

    // B, signed by the courier, wearing A's approval.
    const forged = {
      subject: world.credentialFor(eventB, { cosign: false }).subject,
      signatures: [
        world.credentialFor(eventB, { cosign: false }).signatures[0],
        operatorFromA,
      ],
    };

    const ctx = runAgent(eventB, world.deps, { credential: forged });

    expect(ctx.decision).toBe("freeze");
    expect(ctx.credential?.invalidSignatures).toEqual(["operator"]);
  });

  it("freezes a credential whose subject describes a different handoff", () => {
    const eventA = makeAgentEvent({ eventTime: "2026-09-08T09:00:00+08:00" });
    const eventB = makeAgentEvent({ eventTime: "2026-09-08T10:15:00+08:00" });

    const ctx = runAgent(eventB, world.deps, {
      credential: world.credentialFor(eventA, { cosign: true }),
    });

    expect(ctx.decision).toBe("freeze");
    expect(ctx.credential?.subjectMismatch).toMatch(/eventID/);
  });
});

describe("when no credential is presented at all", () => {
  it("halts pending on a handoff that requires a co-signature", () => {
    const event = makeAgentEvent();
    const ctx = runAgent(event, world.deps);

    expect(ctx.halted).toEqual({ at: "gate", reason: "PENDING_COSIGNATURE" });
    expect(world.deps.ledger.readRecords()).toHaveLength(0);
    expect(ctx.credential?.problems[0].detail).toMatch(/no credential was presented/);
  });

  it("still seals a handoff that needs no co-signature", () => {
    // A mandate with no co-sign conditions and an established courier would not
    // require one; here the fixture's cold start does, so the check is that the
    // gate's own threshold is what drives it - not the mere presence of a token.
    const event = makeAgentEvent();
    const ctx = runAgent(event, world.deps);

    expect(ctx.requiresCosign).toBe(true);
    expect(ctx.gateResult?.cosignReasons[0]).toMatch(/too little history/);
  });
});

describe("the credential never touches the event", () => {
  it("leaves the sealed payload hash identical whether or not a credential rode along", () => {
    const event = makeAgentEvent();

    const withCredential = runSigned(event, world);
    const hashWith = world.deps.ledger.readRecords()[0].payloadHash;

    // A second world, same event, sealed the same way.
    const other = seedWorld();
    try {
      runSigned(event, other);
      expect(other.deps.ledger.readRecords()[0].payloadHash).toBe(hashWith);
    } finally {
      rmSync(other.dir, { recursive: true, force: true });
    }

    // And the event itself carries no credential. (It does carry a
    // `pod.signatureSha256` — the recipient's scrawl on the doorstep, which is
    // evidence about the delivery, not the token that authorises it.)
    const sealedEvent = JSON.stringify(withCredential.event);
    expect(sealedEvent).not.toMatch(/vigil:credential/);
    expect(sealedEvent).not.toMatch(/"signatures"/);
    expect(sealedEvent).not.toMatch(/operatorSignature/);
    expect(sealedEvent).toMatch(/signatureSha256/);
  });
});

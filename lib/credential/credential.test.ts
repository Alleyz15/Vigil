import { describe, expect, it } from "vitest";
import { canonicalize } from "@/lib/ledger/canonical";
import { messageFor, subjectMatches } from "./message";
import { cosign, courierCredential, generateKeyPair, signSubject } from "./sign";
import { describeVerification, verifyCredential } from "./verify";
import { Credential, type HandoffSubject } from "./types";

/**
 * The constitutive co-signature.
 *
 * Every keypair here is generated in-process, so nothing reads an environment
 * variable and no key is committed.
 */

const courier = generateKeyPair();
const operator = generateKeyPair();
const impostor = generateKeyPair();

const HANDOFF_A: HandoffSubject = {
  eventID: "6f8c0d3e-4a1b-4c2d-9e5f-2b7a1c3d4e5f",
  epc: "urn:epc:id:sgtin:0614141.107346.2017",
  courierId: "CR-0042",
  mandateId: "MD-0001",
};

const HANDOFF_B: HandoffSubject = {
  eventID: "11111111-2222-4333-8444-555555555555",
  epc: "urn:epc:id:sgtin:0614141.107346.9999",
  courierId: "CR-0042",
  mandateId: "MD-0001",
};

const subjectFor = (handoff: HandoffSubject, nonce = "n-0001") => ({ ...handoff, v: 1 as const, nonce });

const keys = { courierPublicKey: courier.publicKey, operatorPublicKey: operator.publicKey };

const verify = (credential: Credential, handoff: HandoffSubject, cosignRequired: boolean) =>
  verifyCredential({ credential, handoff, keys, cosignRequired });

describe("the signed message", () => {
  it("uses the one canonicalisation in the codebase", () => {
    const subject = subjectFor(HANDOFF_A);
    const expected = canonicalize({ ...subject, role: "courier" });

    expect(messageFor(subject, "courier").toString("utf8")).toBe(expected);
  });

  it("gives the two roles different bytes, so a signature cannot fill the other slot", () => {
    const subject = subjectFor(HANDOFF_A);
    expect(messageFor(subject, "courier").equals(messageFor(subject, "operator"))).toBe(false);
  });

  it("is insensitive to key order in the subject, like every other hash here", () => {
    const a = messageFor({ ...HANDOFF_A, v: 1, nonce: "n" }, "courier");
    const b = messageFor(
      { nonce: "n", mandateId: HANDOFF_A.mandateId, v: 1, courierId: HANDOFF_A.courierId, epc: HANDOFF_A.epc, eventID: HANDOFF_A.eventID },
      "courier",
    );
    expect(a.equals(b)).toBe(true);
  });

  it("names the field that does not match when a credential is for another handoff", () => {
    expect(subjectMatches(subjectFor(HANDOFF_A), HANDOFF_B)).toMatch(/eventID/);
    expect(subjectMatches(subjectFor(HANDOFF_A), HANDOFF_A)).toBeUndefined();
  });
});

describe("a low-risk handoff needs only the courier", () => {
  it("verifies a valid courier-only credential", () => {
    const credential = courierCredential(subjectFor(HANDOFF_A), courier.privateKey);
    const result = verify(credential, HANDOFF_A, false);

    expect(result.valid).toBe(true);
    expect(result.validSignatures).toEqual(["courier"]);
    expect(result.invalidSignatures).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(describeVerification(result)).toBe("Courier signature verified.");
  });

  it("still verifies when an operator has co-signed something that did not need it", () => {
    const credential = cosign(
      courierCredential(subjectFor(HANDOFF_A), courier.privateKey),
      "OP-01",
      operator.privateKey,
    );

    const result = verify(credential, HANDOFF_A, false);
    expect(result.valid).toBe(true);
    expect(result.validSignatures.sort()).toEqual(["courier", "operator"]);
  });

  it("rejects a forged courier signature even on a low-risk handoff", () => {
    const credential = courierCredential(subjectFor(HANDOFF_A), impostor.privateKey);
    const result = verify(credential, HANDOFF_A, false);

    expect(result.valid).toBe(false);
    expect(result.invalidSignatures).toEqual(["courier"]);
    expect(result.problems[0].code).toBe("BAD_SIGNATURE");
  });
});

/* -------------------------------------------------------------------------- */
/* The demo beat                                                              */
/* -------------------------------------------------------------------------- */

/**
 * THE PITCH LINE, AS A TEST.
 *
 * When a judge asks whether the approval button is real, this is the answer.
 * The courier-only token is not "submitted and marked unapproved" — it does not
 * verify. There is no valid credential for this handoff, and the courier cannot
 * make one, because making one requires a key they do not have.
 */
describe("a co-sign-required handoff", () => {
  it("courier-only credential is cryptographically invalid, not merely unapproved", () => {
    const credential = courierCredential(subjectFor(HANDOFF_A), courier.privateKey);

    // The courier's own signature is perfectly good. That is the point: it is
    // valid, and it is still not enough to assemble a credential.
    const lowRisk = verify(credential, HANDOFF_A, false);
    expect(lowRisk.valid).toBe(true);

    const highRisk = verify(credential, HANDOFF_A, true);

    expect(highRisk.valid).toBe(false);
    expect(highRisk.validSignatures).toEqual(["courier"]);
    expect(highRisk.invalidSignatures).toEqual([]);
    expect(highRisk.problems).toEqual([
      {
        code: "MISSING",
        role: "operator",
        detail: "this handoff requires an operator co-signature and none was presented",
      },
    ]);
  });

  it("verifies once the operator co-signs the same handoff", () => {
    const courierOnly = courierCredential(subjectFor(HANDOFF_A), courier.privateKey);
    expect(verify(courierOnly, HANDOFF_A, true).valid).toBe(false);

    const coSigned = cosign(courierOnly, "OP-01", operator.privateKey);
    const result = verify(coSigned, HANDOFF_A, true);

    expect(result.valid).toBe(true);
    expect(result.validSignatures.sort()).toEqual(["courier", "operator"]);
    expect(describeVerification(result)).toBe("Courier and operator signatures both verified.");
  });

  it("keeps the courier's signature attributed to the courier", () => {
    const coSigned = cosign(
      courierCredential(subjectFor(HANDOFF_A), courier.privateKey),
      "OP-01",
      operator.privateKey,
    );

    expect(coSigned.signatures.find((s) => s.role === "courier")?.signerId).toBe("CR-0042");
    expect(coSigned.signatures.find((s) => s.role === "operator")?.signerId).toBe("OP-01");
  });
});

/* -------------------------------------------------------------------------- */
/* Attacks                                                                    */
/* -------------------------------------------------------------------------- */

describe("a signature cannot be moved to another handoff", () => {
  it("rejects an operator signature lifted from handoff A onto handoff B", () => {
    const approvedA = cosign(
      courierCredential(subjectFor(HANDOFF_A), courier.privateKey),
      "OP-01",
      operator.privateKey,
    );
    const operatorSignatureFromA = approvedA.signatures.find((s) => s.role === "operator")!;

    // Handoff B, signed by the courier, with A's operator approval bolted on.
    const forged: Credential = {
      subject: subjectFor(HANDOFF_B),
      signatures: [
        courierCredential(subjectFor(HANDOFF_B), courier.privateKey).signatures[0],
        operatorSignatureFromA,
      ],
    };

    const result = verify(forged, HANDOFF_B, true);

    expect(result.valid).toBe(false);
    // The lifted signature is cryptographically fine — over A's bytes, not B's.
    expect(result.invalidSignatures).toEqual(["operator"]);
    expect(result.problems.some((p) => p.code === "BAD_SIGNATURE" && p.role === "operator")).toBe(true);
  });

  it("rejects a whole credential presented against a different handoff", () => {
    const approvedA = cosign(
      courierCredential(subjectFor(HANDOFF_A), courier.privateKey),
      "OP-01",
      operator.privateKey,
    );

    const result = verify(approvedA, HANDOFF_B, true);

    expect(result.valid).toBe(false);
    expect(result.subjectMismatch).toMatch(/eventID/);
    // Reported as a mismatch, not a bad signature: the signature is valid, it
    // is simply about a different delivery.
    expect(result.problems).toEqual([]);
    expect(describeVerification(result)).toMatch(/does not match this handoff/);
  });
});

describe("a tampered payload", () => {
  it("rejects a subject edited after signing, even with real signatures", () => {
    const approved = cosign(
      courierCredential(subjectFor(HANDOFF_A), courier.privateKey),
      "OP-01",
      operator.privateKey,
    );

    // Swap the parcel for a more valuable one, keeping both signatures.
    const tampered: Credential = {
      ...approved,
      subject: { ...approved.subject, epc: "urn:epc:id:sgtin:0614141.107346.0001" },
    };

    const result = verifyCredential({
      credential: tampered,
      // Presented against the handoff the tampered subject now claims.
      handoff: { ...HANDOFF_A, epc: "urn:epc:id:sgtin:0614141.107346.0001" },
      keys,
      cosignRequired: true,
    });

    expect(result.valid).toBe(false);
    expect(result.invalidSignatures.sort()).toEqual(["courier", "operator"]);
  });

  it("rejects a changed nonce", () => {
    const approved = cosign(
      courierCredential(subjectFor(HANDOFF_A, "n-0001"), courier.privateKey),
      "OP-01",
      operator.privateKey,
    );
    const tampered: Credential = { ...approved, subject: { ...approved.subject, nonce: "n-0002" } };

    expect(verify(tampered, HANDOFF_A, true).valid).toBe(false);
  });
});

describe("the wrong operator key", () => {
  it("rejects a co-signature from a key that is not the configured operator's", () => {
    const credential: Credential = {
      subject: subjectFor(HANDOFF_A),
      signatures: [
        courierCredential(subjectFor(HANDOFF_A), courier.privateKey).signatures[0],
        {
          role: "operator",
          signerId: "OP-99",
          signature: signSubject(subjectFor(HANDOFF_A), "operator", impostor.privateKey),
        },
      ],
    };

    const result = verify(credential, HANDOFF_A, true);

    expect(result.valid).toBe(false);
    expect(result.invalidSignatures).toEqual(["operator"]);
    expect(result.problems[0]).toMatchObject({ code: "BAD_SIGNATURE", role: "operator" });
  });

  it("fails closed when no operator key is configured at all", () => {
    const approved = cosign(
      courierCredential(subjectFor(HANDOFF_A), courier.privateKey),
      "OP-01",
      operator.privateKey,
    );

    const result = verifyCredential({
      credential: approved,
      handoff: HANDOFF_A,
      keys: { courierPublicKey: courier.publicKey },
      cosignRequired: true,
    });

    // An unconfigured deployment must not be able to wave high-risk handoffs
    // through by having forgotten to set a variable.
    expect(result.valid).toBe(false);
    expect(result.problems[0].code).toBe("NO_PUBLIC_KEY");
  });

  it("fails closed when the courier has no public key on file", () => {
    const credential = courierCredential(subjectFor(HANDOFF_A), courier.privateKey);

    const result = verifyCredential({
      credential,
      handoff: HANDOFF_A,
      keys: { operatorPublicKey: operator.publicKey },
      cosignRequired: false,
    });

    expect(result.valid).toBe(false);
    expect(result.problems[0]).toMatchObject({ code: "NO_PUBLIC_KEY", role: "courier" });
  });

  it("rejects a malformed key rather than throwing", () => {
    const credential = courierCredential(subjectFor(HANDOFF_A), courier.privateKey);

    const result = verifyCredential({
      credential,
      handoff: HANDOFF_A,
      keys: { courierPublicKey: "not-a-key" },
      cosignRequired: false,
    });

    expect(result.valid).toBe(false);
    expect(result.problems[0].code).toBe("MALFORMED_KEY");
  });
});

describe("verification reports what it found, not a boolean", () => {
  it("distinguishes a missing co-signature from a forged one", () => {
    const missing = verify(courierCredential(subjectFor(HANDOFF_A), courier.privateKey), HANDOFF_A, true);

    const forged = verify(
      {
        subject: subjectFor(HANDOFF_A),
        signatures: [
          courierCredential(subjectFor(HANDOFF_A), courier.privateKey).signatures[0],
          { role: "operator", signerId: "OP-99", signature: signSubject(subjectFor(HANDOFF_A), "operator", impostor.privateKey) },
        ],
      },
      HANDOFF_A,
      true,
    );

    // Both are `valid: false`. They are not the same situation, and an operator
    // must be able to tell them apart.
    expect(missing.valid).toBe(false);
    expect(forged.valid).toBe(false);
    expect(missing.problems[0].code).toBe("MISSING");
    expect(forged.problems[0].code).toBe("BAD_SIGNATURE");
    expect(missing.invalidSignatures).toEqual([]);
    expect(forged.invalidSignatures).toEqual(["operator"]);
  });

  it("rejects two signatures claiming the same role", () => {
    const subject = subjectFor(HANDOFF_A);
    const credential: Credential = {
      subject,
      signatures: [
        { role: "operator", signerId: "OP-01", signature: signSubject(subject, "operator", operator.privateKey) },
        { role: "operator", signerId: "OP-02", signature: signSubject(subject, "operator", impostor.privateKey) },
      ],
    };

    const result = verify(credential, HANDOFF_A, true);

    expect(result.valid).toBe(false);
    expect(result.problems.some((p) => p.code === "DUPLICATE_ROLE")).toBe(true);
  });

  it("reports the missing courier signature when only an operator signed", () => {
    const subject = subjectFor(HANDOFF_A);
    const result = verify(
      {
        subject,
        signatures: [
          { role: "operator", signerId: "OP-01", signature: signSubject(subject, "operator", operator.privateKey) },
        ],
      },
      HANDOFF_A,
      true,
    );

    expect(result.valid).toBe(false);
    expect(result.problems.some((p) => p.code === "MISSING" && p.role === "courier")).toBe(true);
  });

  it("always reports whether a co-signature was required", () => {
    const credential = courierCredential(subjectFor(HANDOFF_A), courier.privateKey);
    expect(verify(credential, HANDOFF_A, false).cosignRequired).toBe(false);
    expect(verify(credential, HANDOFF_A, true).cosignRequired).toBe(true);
  });
});

describe("determinism", () => {
  it("gives the same answer every time for the same inputs", () => {
    const credential = cosign(
      courierCredential(subjectFor(HANDOFF_A), courier.privateKey),
      "OP-01",
      operator.privateKey,
    );

    const runs = Array.from({ length: 20 }, () =>
      JSON.stringify(verify(credential, HANDOFF_A, true)),
    );
    expect(new Set(runs).size).toBe(1);
  });

  it("produces a schema-valid credential", () => {
    const credential = cosign(
      courierCredential(subjectFor(HANDOFF_A), courier.privateKey),
      "OP-01",
      operator.privateKey,
    );
    expect(Credential.safeParse(credential).success).toBe(true);
  });
});

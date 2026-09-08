import { z } from "zod";

/**
 * The constitutive co-signature.
 *
 * Operator approval is NOT a database flag. For a high-risk handoff, a valid
 * credential requires signatures from the courier's key AND the operator's key.
 * A courier-only token against such a handoff does not "record as unapproved" —
 * it FAILS CRYPTOGRAPHIC VERIFICATION. There is no valid credential to seal.
 *
 * THE CREDENTIAL IS A SIDECAR. It never travels inside the EPCIS event.
 * See CLAUDE.md: embedding it would make a co-signed resubmission a different
 * payload under the same eventID, which the ledger would correctly abort as
 * EVENT_ID_REUSE — so co-signing would freeze the courier for co-signing.
 */

/** Who signed. Bound into the message so a signature cannot fill the other slot. */
export const SignerRole = z.enum(["courier", "operator"]);
export type SignerRole = z.infer<typeof SignerRole>;

/**
 * Exactly what gets signed, before canonicalisation.
 *
 * Binding eventID and epc is what makes a signature non-transferable: a
 * signature lifted from handoff A covers A's bytes, and presenting it against
 * handoff B verifies against different bytes and fails.
 */
export const SignedPayload = z.strictObject({
  /** Format version. Bumping it invalidates every prior signature by design. */
  v: z.literal(1),
  role: SignerRole,
  eventID: z.uuid(),
  epc: z.string().min(1),
  courierId: z.string().min(1),
  mandateId: z.string().min(1),
  /**
   * Freshness value chosen by the signer.
   *
   * BOUND BY THE SIGNATURE, BUT NOT CHECKED FOR MONOTONICITY. We have
   * cross-handoff replay protection via the eventID binding, and we do NOT have
   * cross-time replay protection. Do not imply otherwise. See CLAUDE.md.
   */
  nonce: z.string().min(1),
});
export type SignedPayload = z.infer<typeof SignedPayload>;

/** One party's signature over their own role's message. */
export const Signature = z.strictObject({
  role: SignerRole,
  /** Ed25519 signature, base64. */
  signature: z.string().min(1),
  /** Which key signed, for the audit trail. Courier id, or an operator id. */
  signerId: z.string().min(1),
});
export type Signature = z.infer<typeof Signature>;

/**
 * The token presented alongside a handoff.
 *
 * `subject` is the handoff being attested to; the signatures cover it. Both
 * parties sign the same subject with their own role, so the operator's
 * signature is an attestation about THIS handoff and nothing else.
 */
export const Credential = z.strictObject({
  subject: SignedPayload.omit({ role: true }),
  signatures: z.array(Signature).min(1).max(2),
});
export type Credential = z.infer<typeof Credential>;

/** Public keys the verifier checks against. Supplied by the caller. */
export type VerificationKeys = {
  /** SPKI DER, base64. From `couriers.publicKey`. */
  courierPublicKey?: string;
  /** SPKI DER, base64. From the environment; see ./keys.ts. */
  operatorPublicKey?: string;
};

/** Why one signature did not count. */
export type SignatureProblem =
  | { code: "MISSING"; role: SignerRole; detail: string }
  | { code: "NO_PUBLIC_KEY"; role: SignerRole; detail: string }
  | { code: "MALFORMED_KEY"; role: SignerRole; detail: string }
  | { code: "BAD_SIGNATURE"; role: SignerRole; detail: string }
  | { code: "DUPLICATE_ROLE"; role: SignerRole; detail: string };

/**
 * What verification found.
 *
 * Deliberately NOT a boolean. An operator needs to know which signatures were
 * present and which were valid — "the courier signed correctly but no operator
 * has co-signed" and "someone presented a forged courier signature" are
 * completely different situations and must not collapse into `false`.
 */
export type VerificationResult = {
  /** True only when every signature the threshold demands is present AND valid. */
  valid: boolean;
  /** Whether the handoff needed a co-signature at all. */
  cosignRequired: boolean;
  /** Roles whose signature was present and verified against their public key. */
  validSignatures: SignerRole[];
  /** Roles whose signature was present but did not verify. */
  invalidSignatures: SignerRole[];
  /** Everything that went wrong, in the order it was found. */
  problems: SignatureProblem[];
  /**
   * Set when the credential does not describe the handoff it was presented
   * with — a signature lifted from another handoff, or a tampered subject.
   */
  subjectMismatch?: string;
};

/** The handoff a credential is being checked against. */
export type HandoffSubject = {
  eventID: string;
  epc: string;
  courierId: string;
  mandateId: string;
};

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { messageFor, subjectMatches } from "./message";
import type {
  Credential,
  HandoffSubject,
  SignatureProblem,
  SignerRole,
  VerificationKeys,
  VerificationResult,
} from "./types";

export type RoleCredential<S extends Record<string, unknown>> = {
  subject: S;
  signatures: { role: SignerRole; signature: string; signerId: string }[];
};

/**
 * The shared constitutive threshold: verify role-bound signatures, then require
 * every named role. Handoffs and reroutes use this same path; only their strict
 * subject schemas and canonical message builders differ.
 */
export function verifyRequiredSignatures<S extends Record<string, unknown>>(args: {
  credential: RoleCredential<S>;
  keys: VerificationKeys;
  required: SignerRole[];
  message: (subject: S, role: SignerRole) => Buffer;
  cosignRequired: boolean;
  operatorMissingDetail?: string;
}): VerificationResult {
  const { credential, keys, required, message, cosignRequired } = args;
  const validSignatures: SignerRole[] = [];
  const invalidSignatures: SignerRole[] = [];
  const problems: SignatureProblem[] = [];
  const seen = new Set<SignerRole>();

  for (const entry of credential.signatures) {
    if (seen.has(entry.role)) {
      problems.push({
        code: "DUPLICATE_ROLE",
        role: entry.role,
        detail: `more than one ${entry.role} signature was presented`,
      });
      invalidSignatures.push(entry.role);
      continue;
    }
    seen.add(entry.role);

    const publicKeyB64 =
      entry.role === "courier" ? keys.courierPublicKey : keys.operatorPublicKey;
    if (!publicKeyB64) {
      problems.push({
        code: "NO_PUBLIC_KEY",
        role: entry.role,
        detail: `no public key on file for the ${entry.role}; the signature cannot be checked`,
      });
      invalidSignatures.push(entry.role);
      continue;
    }

    let ok = false;
    try {
      const key = createPublicKey({
        key: Buffer.from(publicKeyB64, "base64"),
        format: "der",
        type: "spki",
      });
      ok = cryptoVerify(
        null,
        message(credential.subject, entry.role),
        key,
        Buffer.from(entry.signature, "base64"),
      );
    } catch (err) {
      problems.push({
        code: "MALFORMED_KEY",
        role: entry.role,
        detail: `the ${entry.role} key or signature could not be read: ${(err as Error).message}`,
      });
      invalidSignatures.push(entry.role);
      continue;
    }

    if (ok) validSignatures.push(entry.role);
    else {
      invalidSignatures.push(entry.role);
      problems.push({
        code: "BAD_SIGNATURE",
        role: entry.role,
        detail: `the ${entry.role} signature does not verify against the key on file`,
      });
    }
  }

  for (const role of required) {
    if (!validSignatures.includes(role) && !invalidSignatures.includes(role)) {
      problems.push({
        code: "MISSING",
        role,
        detail:
          role === "operator"
            ? (args.operatorMissingDetail ??
              "this action requires an operator co-signature and none was presented")
            : "no courier signature was presented",
      });
    }
  }

  return {
    valid: required.every((role) => validSignatures.includes(role)),
    cosignRequired,
    validSignatures,
    invalidSignatures,
    problems,
  };
}

/**
 * Verify a credential against a handoff and a threshold.
 *
 * DETERMINISTIC. Same credential, same keys, same threshold, same answer, every
 * time — no clock, no randomness, no I/O. `node:crypto` is the one import here
 * that the purity test would normally ban, and it is allowed for exactly that
 * reason: signature verification is a pure function of its inputs, which is the
 * property the purity rule actually protects. See lib/purity.test.ts.
 *
 * THE THRESHOLD RULE
 * ------------------
 *   cosignRequired = false  ->  a valid courier signature suffices
 *   cosignRequired = true   ->  courier AND operator signatures must both verify
 *
 * A courier-only token against a co-sign-required handoff returns `valid:
 * false`. That is not a policy rejection recorded as "unapproved" — there is no
 * valid credential to present. Without the operator's key the token cannot be
 * assembled at all. See CLAUDE.md.
 */
export function verifyCredential(args: {
  credential: Credential;
  handoff: HandoffSubject;
  keys: VerificationKeys;
  cosignRequired: boolean;
}): VerificationResult {
  const { credential, handoff, keys, cosignRequired } = args;

  // A credential about a different handoff is rejected before any signature is
  // checked. The signature may be perfectly valid — over other bytes.
  const mismatch = subjectMatches(credential.subject, handoff);
  if (mismatch) {
    return {
      valid: false,
      cosignRequired,
      validSignatures: [],
      invalidSignatures: [],
      problems: [],
      subjectMismatch: mismatch,
    };
  }

  // The threshold. A courier signature is always required; the operator's is
  // required exactly when the gate said so.
  const required: SignerRole[] = cosignRequired ? ["courier", "operator"] : ["courier"];
  return verifyRequiredSignatures({
    credential,
    keys,
    required,
    message: messageFor,
    cosignRequired,
    operatorMissingDetail: "this handoff requires an operator co-signature and none was presented",
  });
}

/** A one-line summary for the operator console and the trace. */
export function describeVerification(result: VerificationResult): string {
  if (result.subjectMismatch) return `Credential does not match this handoff: ${result.subjectMismatch}`;
  if (result.valid) {
    return result.cosignRequired
      ? "Courier and operator signatures both verified."
      : "Courier signature verified.";
  }
  if (result.problems.length === 0) return "Credential did not verify.";
  return result.problems.map((p) => p.detail).join(" ");
}

import { canonicalize } from "@/lib/ledger/canonical";
import type { Credential, SignedPayload, SignerRole } from "./types";

/**
 * What exactly is signed.
 *
 * ONE CANONICALISATION IN THE CODEBASE. This reuses `canonicalize` from
 * lib/ledger rather than defining a second one. Two canonicalisations that
 * drift apart would mean a signature that verifies in one place and fails in
 * another, and the disagreement would surface as an unexplainable rejection.
 *
 * The bytes are UTF-8 of the canonical JSON: keys sorted, no insignificant
 * whitespace. Both parties sign the same subject, each under their own role.
 */
export function messageFor(subject: Credential["subject"], role: SignerRole): Buffer {
  const payload: SignedPayload = { ...subject, role };
  return roleMessageFor(payload);
}

/**
 * Canonical bytes for any constitutive credential whose schema binds `role`.
 * Existing handoff messages call this with the exact same object as before, so
 * adding another action credential does not change one previously signed byte.
 */
export function roleMessageFor(payload: Record<string, unknown>): Buffer {
  return Buffer.from(canonicalize(payload), "utf8");
}

/**
 * Whether a credential's subject describes the handoff it was presented with.
 *
 * This is the check that makes a signature non-transferable. The signature is
 * cryptographically valid over its OWN subject; lifting it onto another handoff
 * is caught here, before the signature is even checked, and reported as a
 * subject mismatch rather than a bad signature — because the signature is fine,
 * it is simply about a different delivery.
 */
export function subjectMatches(
  subject: Credential["subject"],
  handoff: { eventID: string; epc: string; courierId: string; mandateId: string },
): string | undefined {
  const fields: (keyof typeof handoff)[] = ["eventID", "epc", "courierId", "mandateId"];

  for (const field of fields) {
    if (subject[field] !== handoff[field]) {
      return `credential is bound to ${field} ${JSON.stringify(subject[field])}, but this handoff has ${JSON.stringify(handoff[field])}`;
    }
  }
  return undefined;
}

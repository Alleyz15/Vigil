import type { VerificationKeys } from "./types";

/**
 * Where keys come from.
 *
 * ENV VARS ONLY, AND THAT IS A STATED LIMITATION, NOT AN OVERSIGHT.
 * A production deployment needs an HSM or a managed KMS: the operator's signing
 * key is the thing that makes approval constitutive, and a key sitting in an
 * environment variable can be read by anything that can read the process
 * environment. It is in CLAUDE.md's Known Limitations and belongs in the
 * submission's, too.
 *
 * This is the ONLY impure file in lib/credential — everything else is a pure
 * function of its arguments.
 */

export const OPERATOR_PUBLIC_KEY_ENV = "VIGIL_OPERATOR_PUBLIC_KEY";
export const OPERATOR_PRIVATE_KEY_ENV = "VIGIL_OPERATOR_PRIVATE_KEY";
export const OPERATOR_ID_ENV = "VIGIL_OPERATOR_ID";

/** The operator's public key, for verification. Undefined when unconfigured. */
export function operatorPublicKey(): string | undefined {
  return process.env[OPERATOR_PUBLIC_KEY_ENV] || undefined;
}

/** The operator's private key, for the console's co-sign action. */
export function operatorPrivateKey(): string | undefined {
  return process.env[OPERATOR_PRIVATE_KEY_ENV] || undefined;
}

export function operatorId(): string {
  return process.env[OPERATOR_ID_ENV] || "operator-unconfigured";
}

/**
 * Assemble the verification keys for one handoff.
 *
 * An absent operator key is NOT an error here — it becomes a NO_PUBLIC_KEY
 * problem at verification time, which fails closed. An unconfigured deployment
 * cannot co-sign anything, which is the correct behaviour: it must not be able
 * to wave high-risk handoffs through by having forgotten to set a variable.
 */
export function verificationKeys(courierPublicKey?: string | null): VerificationKeys {
  return {
    courierPublicKey: courierPublicKey ?? undefined,
    operatorPublicKey: operatorPublicKey(),
  };
}

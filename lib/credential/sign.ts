import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { messageFor } from "./message";
import type { Credential, SignerRole } from "./types";

/**
 * Signing helpers.
 *
 * IN PRODUCTION THE COURIER'S HALF NEVER RUNS HERE. The private key lives in
 * the handset's hardware keystore and the device signs before it ever transmits.
 * This exists because the prototype has no mobile app — the event injector plays
 * the device, as recorded in the scope discipline — and because the operator
 * console genuinely does need to sign server-side.
 */

/** An Ed25519 keypair as base64 DER, the form the database and env vars hold. */
export type KeyPairB64 = { publicKey: string; privateKey: string };

export function generateKeyPair(): KeyPairB64 {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

/** Sign a subject in one role. Returns the base64 signature. */
export function signSubject(
  subject: Credential["subject"],
  role: SignerRole,
  privateKeyB64: string,
): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return cryptoSign(null, messageFor(subject, role), key).toString("base64");
}

/** Build a courier-signed credential — the token a device would submit. */
export function courierCredential(
  subject: Credential["subject"],
  courierPrivateKeyB64: string,
): Credential {
  return {
    subject,
    signatures: [
      {
        role: "courier",
        signerId: subject.courierId,
        signature: signSubject(subject, "courier", courierPrivateKeyB64),
      },
    ],
  };
}

/**
 * Add an operator's co-signature to an existing credential.
 *
 * This is the whole primitive: the operator's signature is not appended to a
 * record that was already valid, it is what MAKES the credential valid for a
 * high-risk handoff. Without this call the token cannot be assembled.
 */
export function cosign(
  credential: Credential,
  operatorId: string,
  operatorPrivateKeyB64: string,
): Credential {
  return {
    subject: credential.subject,
    signatures: [
      ...credential.signatures.filter((s) => s.role !== "operator"),
      {
        role: "operator",
        signerId: operatorId,
        signature: signSubject(credential.subject, "operator", operatorPrivateKeyB64),
      },
    ],
  };
}

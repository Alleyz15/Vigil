import { roleMessageFor, signRoleSubject, verifyRequiredSignatures } from "@/lib/credential";
import type { SignerRole, VerificationKeys, VerificationResult } from "@/lib/credential";
import {
  RerouteCredential,
  RerouteCredentialSubject,
  RerouteProposal,
  type RerouteAcceptance,
} from "./types";

function targetId(proposal: RerouteProposal): string {
  return proposal.kind === "pickup_point"
    ? proposal.target.pickupPointId
    : proposal.target.courierId;
}

function targetBizLocation(proposal: RerouteProposal): string {
  return proposal.kind === "pickup_point"
    ? proposal.target.bizLocation
    : proposal.target.destinationBizLocation;
}

export function rerouteSubject(proposal: RerouteProposal, nonce: string) {
  return RerouteCredentialSubject.parse({
    v: 1,
    credentialType: "reroute",
    proposalId: proposal.proposalId,
    sourceEventID: proposal.sourceEventID,
    epc: proposal.epc,
    currentCourierId: proposal.currentCourierId,
    authorizingMandateId: proposal.authorizingMandateId,
    action: proposal.kind,
    targetId: targetId(proposal),
    targetBizLocation: targetBizLocation(proposal),
    targetLatitude: proposal.target.latitude,
    targetLongitude: proposal.target.longitude,
    nonce,
  });
}

function message(subject: RerouteCredential["subject"], role: SignerRole): Buffer {
  return roleMessageFor({ ...subject, role });
}

export function courierRerouteCredential(
  proposal: RerouteProposal,
  nonce: string,
  courierPrivateKeyB64: string,
): RerouteCredential {
  const subject = rerouteSubject(proposal, nonce);
  return {
    subject,
    signatures: [
      {
        role: "courier",
        signerId: proposal.currentCourierId,
        signature: signRoleSubject(subject, "courier", courierPrivateKeyB64),
      },
    ],
  };
}

export function cosignReroute(
  credential: RerouteCredential,
  operatorId: string,
  operatorPrivateKeyB64: string,
): RerouteCredential {
  return {
    subject: credential.subject,
    signatures: [
      ...credential.signatures.filter((entry) => entry.role !== "operator"),
      {
        role: "operator",
        signerId: operatorId,
        signature: signRoleSubject(credential.subject, "operator", operatorPrivateKeyB64),
      },
    ],
  };
}

function mismatchFor(
  proposal: RerouteProposal,
  subject: RerouteCredential["subject"],
): string | undefined {
  const expected = rerouteSubject(proposal, subject.nonce);
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (expected[key] !== subject[key]) {
      return `credential is bound to ${key} ${JSON.stringify(subject[key])}, but this proposal has ${JSON.stringify(expected[key])}`;
    }
  }
  return undefined;
}

export function verifyRerouteCredential(
  proposal: RerouteProposal,
  credential: RerouteCredential,
  keys: VerificationKeys,
): VerificationResult {
  const mismatch = mismatchFor(proposal, credential.subject);
  if (mismatch) {
    return {
      valid: false,
      cosignRequired: true,
      validSignatures: [],
      invalidSignatures: [],
      problems: [],
      subjectMismatch: mismatch,
    };
  }

  return verifyRequiredSignatures({
    credential,
    keys,
    required: ["courier", "operator"],
    message,
    cosignRequired: true,
  });
}

/** Approval exists only when the two-signature credential verifies. */
export function acceptReroute(
  rawProposal: RerouteProposal,
  rawCredential: RerouteCredential,
  keys: VerificationKeys,
): RerouteAcceptance {
  const proposal = RerouteProposal.parse(rawProposal);
  const credential = RerouteCredential.parse(rawCredential);
  const verification = verifyRerouteCredential(proposal, credential, keys);
  return {
    accepted: verification.valid,
    proposal: verification.valid ? { ...proposal, approvalState: "approved" } : proposal,
    verification,
  };
}

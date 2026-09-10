import { z } from "zod";
import type { Decision } from "@/lib/ledger/types";
import type { CourierMandate } from "@/lib/mandate/schema";
import { Signature, type VerificationKeys, type VerificationResult } from "@/lib/credential";

export const PickupPoint = z.strictObject({
  pickupPointId: z.string().min(1),
  label: z.string().min(1),
  bizLocation: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  active: z.boolean(),
});
export type PickupPoint = z.infer<typeof PickupPoint>;

const PickupTarget = z.strictObject({
  pickupPointId: z.string().min(1),
  label: z.string().min(1),
  bizLocation: z.string().min(1),
  latitude: z.number(),
  longitude: z.number(),
  distanceMeters: z.number().nonnegative(),
});

const CourierTarget = z.strictObject({
  courierId: z.string().min(1),
  mandateId: z.string().min(1),
  destinationBizLocation: z.string().min(1),
  latitude: z.number(),
  longitude: z.number(),
});

const ProposalBase = {
  v: z.literal(1),
  proposalId: z.string().min(1),
  sourceEventID: z.uuid(),
  epc: z.string().min(1),
  currentCourierId: z.string().min(1),
  authorizingMandateId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  approvalState: z.enum(["pending_operator_cosignature", "approved"]),
};

export const RerouteProposal = z.discriminatedUnion("kind", [
  z.strictObject({ ...ProposalBase, kind: z.literal("pickup_point"), target: PickupTarget }),
  z.strictObject({
    ...ProposalBase,
    kind: z.literal("courier_reassignment"),
    target: CourierTarget,
  }),
]);
export type RerouteProposal = z.infer<typeof RerouteProposal>;

export type RerouteInput = {
  decision: Decision;
  sourceEventID: string;
  epc: string;
  currentCourierId: string;
  currentMandate?: CourierMandate;
  eventTime: string;
  destination?: { bizLocation?: string; latitude: number; longitude: number };
  pickupPoints: PickupPoint[];
  alternateCouriers: { courierId: string; mandate: CourierMandate }[];
};

/**
 * One candidate the selector looked at, and what happened to it.
 *
 * PRODUCED BY THE SELECTOR, never re-derived by a view. The exclusion reasons
 * are the filter predicates' own words — mandate expired, EPC prefix out of
 * scope, location not covered, farther than the winner. A panel that worked out
 * "why not that one?" for itself would be a second implementation of the
 * eligibility rules, drifting from the first the moment a mandate rule moved.
 */
export type RerouteCandidate = {
  kind: "pickup_point" | "courier_reassignment";
  id: string;
  label: string;
  selected: boolean;
  /** Why it won, or why it lost. Always populated. */
  reason: string;
  distanceMeters?: number;
};

export type RerouteOutcome =
  | { status: "not_applicable"; reason: string; considered: RerouteCandidate[] }
  | { status: "unavailable"; reason: string; considered: RerouteCandidate[] }
  | { status: "proposed"; proposal: RerouteProposal; considered: RerouteCandidate[] };

export const RerouteCredentialSubject = z.strictObject({
  v: z.literal(1),
  credentialType: z.literal("reroute"),
  proposalId: z.string().min(1),
  sourceEventID: z.uuid(),
  epc: z.string().min(1),
  currentCourierId: z.string().min(1),
  authorizingMandateId: z.string().min(1),
  action: z.enum(["pickup_point", "courier_reassignment"]),
  targetId: z.string().min(1),
  targetBizLocation: z.string().min(1),
  targetLatitude: z.number().min(-90).max(90),
  targetLongitude: z.number().min(-180).max(180),
  nonce: z.string().min(1),
});
export type RerouteCredentialSubject = z.infer<typeof RerouteCredentialSubject>;

export const RerouteCredential = z.strictObject({
  subject: RerouteCredentialSubject,
  signatures: z.array(Signature).min(1).max(2),
});
export type RerouteCredential = z.infer<typeof RerouteCredential>;

export type RerouteAcceptance = {
  accepted: boolean;
  proposal: RerouteProposal;
  verification: VerificationResult;
};

export type { VerificationKeys };

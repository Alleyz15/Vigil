import type { VigilDb } from "@/lib/db/client";
import { rerouteProposals } from "@/lib/db/schema";
import type { RerouteCredential, RerouteProposal } from "./types";

function target(proposal: RerouteProposal) {
  return proposal.kind === "pickup_point"
    ? {
        id: proposal.target.pickupPointId,
        label: proposal.target.label,
        bizLocation: proposal.target.bizLocation,
        lat: proposal.target.latitude,
        lng: proposal.target.longitude,
      }
    : {
        id: proposal.target.courierId,
        label: `Reassign to ${proposal.target.courierId}`,
        bizLocation: proposal.target.destinationBizLocation,
        lat: proposal.target.latitude,
        lng: proposal.target.longitude,
      };
}

export function persistReroute(
  db: VigilDb,
  proposal: RerouteProposal,
  credential?: RerouteCredential,
): void {
  const resolved = target(proposal);
  db.insert(rerouteProposals)
    .values({
      proposalId: proposal.proposalId,
      sourceEventId: proposal.sourceEventID,
      epc: proposal.epc,
      currentCourierId: proposal.currentCourierId,
      kind: proposal.kind,
      targetId: resolved.id,
      targetLabel: resolved.label,
      targetBizLocation: resolved.bizLocation,
      targetLat: resolved.lat,
      targetLng: resolved.lng,
      authorizingMandateId: proposal.authorizingMandateId,
      approvalState: proposal.approvalState,
      credentialJson: credential ? JSON.stringify(credential) : null,
      createdAt: proposal.createdAt,
    })
    .onConflictDoUpdate({
      target: rerouteProposals.proposalId,
      set: {
        approvalState: proposal.approvalState,
        credentialJson: credential ? JSON.stringify(credential) : null,
      },
    })
    .run();
}


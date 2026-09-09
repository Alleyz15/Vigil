import { distance, point } from "@turf/turf";
import { canonicalHash } from "@/lib/ledger";
import type { CourierMandate } from "@/lib/mandate/schema";
import { RerouteProposal, type RerouteInput, type RerouteOutcome } from "./types";

const DELIVERING = "urn:epcglobal:cbv:bizstep:delivering" as const;

function activeAt(mandate: CourierMandate, at: string): boolean {
  const time = Date.parse(at);
  return (
    mandate.status === "active" &&
    Number.isFinite(time) &&
    time >= Date.parse(mandate.validity.notBefore) &&
    time <= Date.parse(mandate.validity.notAfter)
  );
}

function covers(
  mandate: CourierMandate,
  args: { epc: string; bizLocation?: string; at: string },
): boolean {
  if (!activeAt(mandate, args.at)) return false;
  if (
    mandate.scope.epcPrefixes.length > 0 &&
    !mandate.scope.epcPrefixes.some((prefix) => args.epc.startsWith(prefix))
  ) {
    return false;
  }
  if (
    mandate.scope.bizLocations.length > 0 &&
    (!args.bizLocation || !mandate.scope.bizLocations.includes(args.bizLocation))
  ) {
    return false;
  }
  return mandate.scope.bizSteps.length === 0 || mandate.scope.bizSteps.includes(DELIVERING);
}

function metres(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  return distance(point([from.longitude, from.latitude]), point([to.longitude, to.latitude]), {
    units: "meters",
  });
}

function idFor(value: unknown): string {
  return `RP-${canonicalHash(value).slice(0, 24)}`;
}

function pickupProposal(input: RerouteInput): RerouteOutcome | undefined {
  if (!input.destination || !input.currentMandate) return undefined;

  const eligible = input.pickupPoints
    .filter(
      (candidate) =>
        candidate.active &&
        covers(input.currentMandate!, {
          epc: input.epc,
          bizLocation: candidate.bizLocation,
          at: input.eventTime,
        }),
    )
    .map((candidate) => ({ candidate, distanceMeters: metres(input.destination!, candidate) }))
    .sort(
      (a, b) =>
        a.distanceMeters - b.distanceMeters ||
        a.candidate.pickupPointId.localeCompare(b.candidate.pickupPointId),
    );

  const selected = eligible[0];
  if (!selected) return undefined;
  const target = {
    pickupPointId: selected.candidate.pickupPointId,
    label: selected.candidate.label,
    bizLocation: selected.candidate.bizLocation,
    latitude: selected.candidate.latitude,
    longitude: selected.candidate.longitude,
    distanceMeters: Math.round(selected.distanceMeters),
  };
  const identity = {
    sourceEventID: input.sourceEventID,
    epc: input.epc,
    currentCourierId: input.currentCourierId,
    authorizingMandateId: input.currentMandate.mandateId,
    kind: "pickup_point" as const,
    target,
  };

  return {
    status: "proposed",
    proposal: RerouteProposal.parse({
      v: 1,
      ...identity,
      proposalId: idFor(identity),
      createdAt: input.eventTime,
      approvalState: "pending_operator_cosignature",
    }),
  };
}

function courierProposal(input: RerouteInput): RerouteOutcome | undefined {
  if (!input.destination?.bizLocation) return undefined;

  const selected = input.alternateCouriers
    .filter(
      (candidate) =>
        candidate.courierId !== input.currentCourierId &&
        candidate.mandate.courierId === candidate.courierId &&
        covers(candidate.mandate, {
          epc: input.epc,
          bizLocation: input.destination!.bizLocation,
          at: input.eventTime,
        }),
    )
    .sort((a, b) => a.courierId.localeCompare(b.courierId))[0];

  if (!selected) return undefined;
  const target = {
    courierId: selected.courierId,
    mandateId: selected.mandate.mandateId,
    destinationBizLocation: input.destination.bizLocation,
    latitude: input.destination.latitude,
    longitude: input.destination.longitude,
  };
  const identity = {
    sourceEventID: input.sourceEventID,
    epc: input.epc,
    currentCourierId: input.currentCourierId,
    authorizingMandateId: selected.mandate.mandateId,
    kind: "courier_reassignment" as const,
    target,
  };

  return {
    status: "proposed",
    proposal: RerouteProposal.parse({
      v: 1,
      ...identity,
      proposalId: idFor(identity),
      createdAt: input.eventTime,
      approvalState: "pending_operator_cosignature",
    }),
  };
}

/** Post-gate action selection. It never reads a score and never changes a verdict. */
export function proposeReroute(input: RerouteInput): RerouteOutcome {
  if (input.decision === "accept") {
    return { status: "not_applicable", reason: "The handoff was accepted; no reroute is needed." };
  }

  const proposal =
    input.decision === "flag"
      ? pickupProposal(input)
      : courierProposal(input) ?? pickupProposal(input);

  return proposal ?? {
    status: "unavailable",
    reason: "No authorised reroute exists for this address.",
  };
}

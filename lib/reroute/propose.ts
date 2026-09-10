import { distance, point } from "@turf/turf";
import { canonicalHash } from "@/lib/ledger";
import type { CourierMandate } from "@/lib/mandate/schema";
import {
  RerouteProposal,
  type RerouteCandidate,
  type RerouteInput,
  type RerouteOutcome,
} from "./types";

const DELIVERING = "urn:epcglobal:cbv:bizstep:delivering" as const;

/** Internal marker while candidates are being ranked; never surfaced. */
const ELIGIBLE = "eligible";

function activeAt(mandate: CourierMandate, at: string): boolean {
  const time = Date.parse(at);
  return (
    mandate.status === "active" &&
    Number.isFinite(time) &&
    time >= Date.parse(mandate.validity.notBefore) &&
    time <= Date.parse(mandate.validity.notAfter)
  );
}

/**
 * Why a mandate does not authorise this destination, or `undefined` if it does.
 *
 * Returns the REASON rather than a boolean so the rejected-alternatives panel
 * can quote the actual predicate that failed. "No authorised reroute exists" is
 * a true but unhelpful sentence on its own; "the courier's mandate expired at
 * 18:00" is an operator's next action.
 */
function refusal(
  mandate: CourierMandate,
  args: { epc: string; bizLocation?: string; at: string },
): string | undefined {
  if (!activeAt(mandate, args.at)) {
    return mandate.status !== "active"
      ? `the authorising mandate is ${mandate.status}`
      : "the authorising mandate is not valid at this time";
  }
  if (
    mandate.scope.epcPrefixes.length > 0 &&
    !mandate.scope.epcPrefixes.some((prefix) => args.epc.startsWith(prefix))
  ) {
    return "this parcel is outside the mandate's EPC scope";
  }
  if (
    mandate.scope.bizLocations.length > 0 &&
    (!args.bizLocation || !mandate.scope.bizLocations.includes(args.bizLocation))
  ) {
    return "this location is not in the mandate's permitted locations";
  }
  if (mandate.scope.bizSteps.length > 0 && !mandate.scope.bizSteps.includes(DELIVERING)) {
    return "the mandate does not permit delivering";
  }
  return undefined;
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

/** Every pickup point weighed, winner first, each carrying why it won or lost. */
function considerPickupPoints(input: RerouteInput): RerouteCandidate[] {
  if (!input.destination) return [];

  const scored: RerouteCandidate[] = input.pickupPoints.map((candidate) => {
    const distanceMeters = Math.round(metres(input.destination!, candidate));
    const base = {
      kind: "pickup_point" as const,
      id: candidate.pickupPointId,
      label: candidate.label,
      distanceMeters,
      selected: false,
    };

    if (!candidate.active) {
      return { ...base, reason: "this pickup point is not currently active" };
    }
    if (!input.currentMandate) {
      return { ...base, reason: "the courier has no readable mandate to authorise a reroute" };
    }
    const refused = refusal(input.currentMandate, {
      epc: input.epc,
      bizLocation: candidate.bizLocation,
      at: input.eventTime,
    });
    if (refused) return { ...base, reason: refused };

    return { ...base, reason: ELIGIBLE };
  });

  // Eligible candidates sort by distance, ties broken by a stable identifier so
  // the same input always yields the same proposal.
  const eligible = scored
    .filter((candidate) => candidate.reason === ELIGIBLE)
    .sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0) || a.id.localeCompare(b.id));

  eligible.forEach((candidate, index) => {
    if (index === 0) {
      candidate.selected = true;
      candidate.reason = `nearest authorised pickup point, ${candidate.distanceMeters} m from the address`;
      return;
    }
    const winner = eligible[0];
    candidate.reason =
      candidate.distanceMeters === winner.distanceMeters
        ? `equally close, but ${winner.id} sorts first on a stable identifier`
        : `authorised, but ${(candidate.distanceMeters ?? 0) - (winner.distanceMeters ?? 0)} m further than ${winner.label}`;
  });

  const rejected = scored.filter((candidate) => !eligible.includes(candidate));
  return [...eligible, ...rejected];
}

/** Every alternate courier weighed, winner first. */
function considerCouriers(input: RerouteInput): RerouteCandidate[] {
  if (!input.destination?.bizLocation) return [];

  const scored: RerouteCandidate[] = input.alternateCouriers
    .filter((candidate) => candidate.courierId !== input.currentCourierId)
    .sort((a, b) => a.courierId.localeCompare(b.courierId))
    .map((candidate) => {
      const base = {
        kind: "courier_reassignment" as const,
        id: candidate.courierId,
        label: candidate.courierId,
        selected: false,
      };
      if (candidate.mandate.courierId !== candidate.courierId) {
        return { ...base, reason: "the mandate on file names a different courier" };
      }
      const refused = refusal(candidate.mandate, {
        epc: input.epc,
        bizLocation: input.destination!.bizLocation,
        at: input.eventTime,
      });
      if (refused) return { ...base, reason: refused };
      return { ...base, reason: ELIGIBLE };
    });

  const eligible = scored.filter((candidate) => candidate.reason === ELIGIBLE);
  eligible.forEach((candidate, index) => {
    if (index === 0) {
      candidate.selected = true;
      candidate.reason = "first eligible courier, by stable identifier order";
    } else {
      candidate.reason = `authorised, but ${eligible[0].id} sorts first on a stable identifier`;
    }
  });

  return scored;
}

function pickupProposal(
  input: RerouteInput,
  considered: RerouteCandidate[],
): RerouteOutcome | undefined {
  const winner = considered.find((c) => c.selected && c.kind === "pickup_point");
  if (!winner || !input.destination || !input.currentMandate) return undefined;

  const source = input.pickupPoints.find((c) => c.pickupPointId === winner.id);
  if (!source) return undefined;

  const target = {
    pickupPointId: source.pickupPointId,
    label: source.label,
    bizLocation: source.bizLocation,
    latitude: source.latitude,
    longitude: source.longitude,
    distanceMeters: winner.distanceMeters ?? 0,
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
    considered,
    proposal: RerouteProposal.parse({
      v: 1,
      ...identity,
      proposalId: idFor(identity),
      createdAt: input.eventTime,
      approvalState: "pending_operator_cosignature",
    }),
  };
}

function courierProposal(
  input: RerouteInput,
  considered: RerouteCandidate[],
): RerouteOutcome | undefined {
  const winner = considered.find((c) => c.selected && c.kind === "courier_reassignment");
  if (!winner || !input.destination?.bizLocation) return undefined;

  const source = input.alternateCouriers.find((c) => c.courierId === winner.id);
  if (!source) return undefined;

  const target = {
    courierId: source.courierId,
    mandateId: source.mandate.mandateId,
    destinationBizLocation: input.destination.bizLocation,
    latitude: input.destination.latitude,
    longitude: input.destination.longitude,
  };
  const identity = {
    sourceEventID: input.sourceEventID,
    epc: input.epc,
    currentCourierId: input.currentCourierId,
    authorizingMandateId: source.mandate.mandateId,
    kind: "courier_reassignment" as const,
    target,
  };

  return {
    status: "proposed",
    considered,
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
    return {
      status: "not_applicable",
      reason: "The handoff was accepted; no reroute is needed.",
      considered: [],
    };
  }

  const pickups = considerPickupPoints(input);
  // `flag` returns the parcel to a counter; `escalate` and `freeze` take it off
  // this courier first and fall back to a counter. The candidate list follows
  // that preference, so the panel shows what was weighed in the order it was
  // weighed rather than in an order chosen for display.
  const couriers = input.decision === "flag" ? [] : considerCouriers(input);
  const considered = [...couriers, ...pickups];

  const proposal =
    input.decision === "flag"
      ? pickupProposal(input, considered)
      : courierProposal(input, considered) ?? pickupProposal(input, considered);

  return (
    proposal ?? {
      status: "unavailable",
      reason: "No authorised reroute exists for this address.",
      considered,
    }
  );
}

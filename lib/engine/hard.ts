import { epcsOf } from "@/lib/epcis";
import { isPermittedTransition } from "./custody";
import type { EngineInput, Evidence, HardResult } from "./types";

/**
 * H1-H3: the hard checks.
 *
 * These do not score. Any failure aborts the handoff outright — there is no
 * partial accept, because "the parcel is not in your scope, but only a bit" is
 * not a coherent position. H4 (eventID replay) lives in lib/ledger, where the
 * append-only registry that answers it lives.
 *
 * All three are evaluated before the caller aborts, so an operator sees every
 * hard failure at once rather than fixing one and rediscovering the next.
 */

const ev = (field: string, value: unknown): Evidence => ({ field, value });

/**
 * H1 - custody chain continuity.
 *
 * Does the previous event's disposition permit this event's bizStep? A parcel
 * that reports "delivered" without ever having been out for delivery is
 * describing events in an order that did not happen.
 *
 * Passes when there is no previous event (the first scan in a timeline has
 * nothing to contradict) or when either side of the comparison is absent. H1
 * aborts a handoff, so it fires only on a transition we are confident is wrong.
 */
export function h1CustodyContinuity(input: EngineInput): HardResult {
  const bizStep = input.event.bizStep;
  const previousDisposition = input.previous?.disposition;

  if (!bizStep || !previousDisposition) return { status: "pass" };
  if (isPermittedTransition(previousDisposition, bizStep)) return { status: "pass" };

  return {
    status: "fail",
    flag: {
      id: "H1",
      points: 0,
      label:
        "This scan does not follow from the parcel's last known state. The parcel would have had to skip a step.",
      evidence: [
        ev("previous.disposition", previousDisposition),
        ev("event.bizStep", bizStep),
        ev("previous.eventTime", input.previous?.eventTime),
      ],
    },
  };
}

/**
 * H2 - the EPC is inside the courier's mandate scope.
 *
 * Scope has three independent dimensions (parcels, locations, actions) and all
 * three must hold. An empty list means "unrestricted on this dimension", which
 * is how a trusted-route mandate is expressed without disabling the check.
 *
 * A courier with NO mandate fails here rather than passing: an unscoped actor is
 * not an actor with unlimited scope.
 */
export function h2EpcInScope(input: EngineInput): HardResult {
  const mandate = input.mandate;
  if (!mandate) {
    return {
      status: "fail",
      flag: {
        id: "H2",
        points: 0,
        label: "The courier who submitted this scan has no active authorisation on file.",
        evidence: [ev("courier.courierId", input.courier?.courierId ?? null), ev("mandate", null)],
      },
    };
  }

  const epcs = epcsOf(input.event);
  const outOfScopeEpc = epcs.find(
    (epc) =>
      mandate.scope.epcPrefixes.length > 0 &&
      !mandate.scope.epcPrefixes.some((prefix) => epc.startsWith(prefix)),
  );

  if (outOfScopeEpc) {
    return {
      status: "fail",
      flag: {
        id: "H2",
        points: 0,
        label: "This parcel is not on the courier's assigned route.",
        evidence: [
          ev("event.epcList", outOfScopeEpc),
          ev("mandate.scope.epcPrefixes", mandate.scope.epcPrefixes),
        ],
      },
    };
  }

  const location = input.event.bizLocation?.id ?? input.event.readPoint?.id;
  if (
    location &&
    mandate.scope.bizLocations.length > 0 &&
    !mandate.scope.bizLocations.includes(location)
  ) {
    return {
      status: "fail",
      flag: {
        id: "H2",
        points: 0,
        label: "This scan happened at a location the courier is not assigned to.",
        evidence: [
          ev("event.bizLocation", location),
          ev("mandate.scope.bizLocations", mandate.scope.bizLocations),
        ],
      },
    };
  }

  const bizStep = input.event.bizStep;
  if (bizStep && mandate.scope.bizSteps.length > 0 && !mandate.scope.bizSteps.includes(bizStep)) {
    return {
      status: "fail",
      flag: {
        id: "H2",
        points: 0,
        label: "The courier is not authorised to perform this action.",
        evidence: [ev("event.bizStep", bizStep), ev("mandate.scope.bizSteps", mandate.scope.bizSteps)],
      },
    };
  }

  return { status: "pass" };
}

/**
 * H3 - the mandate is active and the event falls within its validity period.
 *
 * Status and validity only. The permitted-HOURS check is I13, which scores
 * rather than aborts: working an hour outside your shift is a policy breach
 * worth flagging, not grounds for voiding the handoff. A revoked mandate is.
 */
export function h3MandateValid(input: EngineInput): HardResult {
  const mandate = input.mandate;
  if (!mandate) {
    // H2 already reported the missing mandate. Reporting it twice would tell an
    // operator there are two problems when there is one.
    return { status: "pass" };
  }

  if (mandate.status !== "active") {
    return {
      status: "fail",
      flag: {
        id: "H3",
        points: 0,
        label: `The courier's authorisation is ${mandate.status}, not active.`,
        evidence: [ev("mandate.status", mandate.status), ev("mandate.mandateId", mandate.mandateId)],
      },
    };
  }

  const eventMs = Date.parse(input.event.eventTime);
  const notBefore = Date.parse(mandate.validity.notBefore);
  const notAfter = Date.parse(mandate.validity.notAfter);

  if (!Number.isFinite(eventMs)) return { status: "pass" };

  if (eventMs < notBefore) {
    return {
      status: "fail",
      flag: {
        id: "H3",
        points: 0,
        label: "This scan is dated before the courier's authorisation begins.",
        evidence: [
          ev("event.eventTime", input.event.eventTime),
          ev("mandate.validity.notBefore", mandate.validity.notBefore),
        ],
      },
    };
  }

  if (eventMs > notAfter) {
    return {
      status: "fail",
      flag: {
        id: "H3",
        points: 0,
        label: "The courier's authorisation had already expired when this scan was made.",
        evidence: [
          ev("event.eventTime", input.event.eventTime),
          ev("mandate.validity.notAfter", mandate.validity.notAfter),
        ],
      },
    };
  }

  return { status: "pass" };
}

/** H1-H3 in order. H4 is the ledger's replay check. */
export const HARD_CHECKS = [h1CustodyContinuity, h2EpcInScope, h3MandateValid] as const;

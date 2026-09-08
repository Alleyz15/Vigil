import type { BizStep, Disposition } from "@/lib/epcis";

/**
 * H1's policy table: which business step may follow a given disposition.
 *
 * This is a POLICY, not a threshold, so it lives here rather than in
 * thresholds.ts — experiment 6 sweeps numbers, not custody rules.
 *
 * What H1 actually catches is a state jump: a parcel that reports being
 * delivered without ever having been out for delivery, or that re-enters the
 * network after being handed over. Those are not physically impossible the way
 * a 300 km/h journey is, but they mean the record is describing something that
 * did not happen in the order it claims.
 */

/**
 * disposition of the PREVIOUS event -> bizSteps this event may legitimately be.
 *
 * A disposition absent from this table imposes no constraint: we would rather
 * decline to judge than invent a rule for a state we have not modelled. H1 is a
 * HARD check and aborts the handoff outright, so it must only fire on
 * transitions we are genuinely confident are wrong.
 */
export const PERMITTED_TRANSITIONS: Partial<Record<Disposition, readonly BizStep[]>> = {
  // Freshly collected or sitting in the network: it can move on, be stored,
  // inspected, or held.
  "urn:epcglobal:cbv:disp:active": [
    "urn:epcglobal:cbv:bizstep:receiving",
    "urn:epcglobal:cbv:bizstep:storing",
    "urn:epcglobal:cbv:bizstep:loading",
    "urn:epcglobal:cbv:bizstep:departing",
    "urn:epcglobal:cbv:bizstep:picking",
    "urn:epcglobal:cbv:bizstep:shipping",
    "urn:epcglobal:cbv:bizstep:inspecting",
    "urn:epcglobal:cbv:bizstep:holding",
  ],

  // On a vehicle between facilities.
  "urn:epcglobal:cbv:disp:in_transit": [
    "urn:epcglobal:cbv:bizstep:transporting",
    "urn:epcglobal:cbv:bizstep:arriving",
    "urn:epcglobal:cbv:bizstep:unloading",
    "urn:epcglobal:cbv:bizstep:receiving",
    "urn:epcglobal:cbv:bizstep:holding",
    "urn:epcglobal:cbv:bizstep:inspecting",
  ],

  // Sitting at a facility.
  "urn:epcglobal:cbv:disp:in_progress": [
    "urn:epcglobal:cbv:bizstep:storing",
    "urn:epcglobal:cbv:bizstep:picking",
    "urn:epcglobal:cbv:bizstep:loading",
    "urn:epcglobal:cbv:bizstep:departing",
    "urn:epcglobal:cbv:bizstep:shipping",
    "urn:epcglobal:cbv:bizstep:transporting",
    "urn:epcglobal:cbv:bizstep:delivering",
    "urn:epcglobal:cbv:bizstep:inspecting",
    "urn:epcglobal:cbv:bizstep:holding",
    "urn:epcglobal:cbv:bizstep:unloading",
  ],

  // In a courier's hands, out for delivery.
  "urn:epcglobal:cbv:disp:in_possession": [
    "urn:epcglobal:cbv:bizstep:transporting",
    "urn:epcglobal:cbv:bizstep:delivering",
    "urn:epcglobal:cbv:bizstep:accepting",
    "urn:epcglobal:cbv:bizstep:arriving",
    "urn:epcglobal:cbv:bizstep:holding",
    "urn:epcglobal:cbv:bizstep:inspecting",
  ],

  // Terminal states. A parcel that is already delivered, returned, stolen or
  // damaged cannot quietly resume its journey; it must be formally received or
  // inspected back into the network first.
  "urn:epcglobal:cbv:disp:retail_sold": [
    "urn:epcglobal:cbv:bizstep:receiving",
    "urn:epcglobal:cbv:bizstep:inspecting",
  ],
  "urn:epcglobal:cbv:disp:returned": [
    "urn:epcglobal:cbv:bizstep:receiving",
    "urn:epcglobal:cbv:bizstep:inspecting",
    "urn:epcglobal:cbv:bizstep:storing",
    "urn:epcglobal:cbv:bizstep:holding",
  ],
  "urn:epcglobal:cbv:disp:stolen": [
    "urn:epcglobal:cbv:bizstep:receiving",
    "urn:epcglobal:cbv:bizstep:inspecting",
  ],
  "urn:epcglobal:cbv:disp:damaged": [
    "urn:epcglobal:cbv:bizstep:receiving",
    "urn:epcglobal:cbv:bizstep:inspecting",
    "urn:epcglobal:cbv:bizstep:holding",
    "urn:epcglobal:cbv:bizstep:storing",
  ],
};

/**
 * Whether `bizStep` may follow `previousDisposition`.
 *
 * Returns true when we have no rule for the previous disposition — H1 aborts a
 * handoff outright, so an unmodelled state must not be grounds for one.
 */
export function isPermittedTransition(
  previousDisposition: Disposition,
  bizStep: BizStep,
): boolean {
  const permitted = PERMITTED_TRANSITIONS[previousDisposition];
  if (!permitted) return true;
  return permitted.includes(bizStep);
}

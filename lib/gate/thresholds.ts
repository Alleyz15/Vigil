import type { Decision } from "@/lib/ledger/types";

/**
 * Where the orthogonal matrix cuts each axis, and how outcomes combine.
 *
 * These are the two numbers the operator console's draggable gate explorer
 * varies, and the two experiment 6 sweeps. They live here so neither the
 * matrix nor a rule contains a literal.
 */

export type GateThresholds = {
  /**
   * Axis 1 at or above this is "high single-event inconsistency".
   *
   * Source: the cheapest single contradiction worth acting on is I11 (+20,
   * scanned away from the address) plus I12's first missing artefact (+15).
   * 30 sits just above one lone mid-weight flag, so a single environmental
   * hiccup does not cross it but two co-occurring contradictions do.
   */
  highInconsistency: number;

  /**
   * Axis 2 at or above this is "high pattern".
   *
   * Source: set so a single P-rule cannot escalate a courier on its own.
   * The cheapest pair is P3 (+20) plus P1 (+25). 40 requires at least two
   * independent pattern signals to agree before anyone is investigated —
   * an accusation about a person should need more than one observation.
   */
  highPattern: number;
};

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = Object.freeze({
  highInconsistency: 30,
  highPattern: 40,
}) as GateThresholds;

/**
 * Severity order. Outcomes combine MONOTONICALLY: a mandate limit check can
 * raise a decision but never lower one, so no later check can quietly turn an
 * escalate into an accept.
 */
export const SEVERITY: Record<Decision, number> = Object.freeze({
  accept: 0,
  flag: 1,
  escalate: 2,
  freeze: 3,
});

/** The more severe of two decisions. */
export function moreSevere(a: Decision, b: Decision): Decision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

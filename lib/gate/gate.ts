import type { Evidence, Flag } from "@/lib/engine/types";
import type { Decision, VerdictBasis } from "@/lib/ledger/types";
import { moreSevere } from "./thresholds";
import type { GateInput, GateResult } from "./types";

/**
 * The orthogonal gate. The ONLY place the two axes meet, and the only place a
 * decision is produced.
 *
 *      single-event  |  pattern  |  outcome
 *      --------------+-----------+---------------------------------
 *      high          |  low      |  flag      request more evidence
 *      low           |  high     |  ESCALATE  investigate the courier
 *      high          |  high     |  freeze    the courier's scope
 *      low           |  low      |  accept
 *
 * Row 2 is the project. Every other system adjudicates event by event; a
 * fraudster careful enough to keep each event under the threshold cannot
 * change their own distribution. THE AXES ARE NEVER SUMMED — summing makes
 * row 2 unreachable and deletes the differentiator. See CLAUDE.md.
 *
 * Pure. No I/O, no clock, no randomness, and no LLM has ever been near it.
 */
export function runGate(input: GateInput): GateResult {
  const { inconsistency, pattern, thresholds } = input;

  const inconsistencyEvaluable = !inconsistency.aborted && inconsistency.coverage.evaluated > 0;
  const patternEvaluable = !pattern.coldStart;

  const axis = {
    inconsistencyScore: inconsistency.score,
    patternScore: pattern.score,
    inconsistencyEvaluable,
    patternEvaluable,
  };

  // A hard check failure voids the handoff outright. It is not a score to be
  // weighed against anything, so it short-circuits the matrix.
  if (inconsistency.aborted) {
    return {
      decision: "freeze",
      basis: "insufficient_evidence",
      requiresCosign: false,
      cosignReasons: [],
      matrixCell: "hard-abort",
      matrixDecision: "freeze",
      limitFlags: [],
      axis,
      rationale: `Handoff refused: ${inconsistency.abortCode ?? "a mandatory check failed"}.`,
    };
  }

  const { decision: matrixDecision, cell, basis, rationale, coldStartCosign } = applyMatrix(
    inconsistencyEvaluable,
    patternEvaluable,
    inconsistency.score >= thresholds.highInconsistency,
    pattern.score >= thresholds.highPattern,
  );

  // Mandate limits and cooldown. These can RAISE the decision, never lower it.
  const limitFlags = checkLimits(input);
  const decision = limitFlags.reduce<Decision>(
    (worst, flag) => moreSevere(worst, decisionForLimit(flag.id)),
    matrixDecision,
  );

  const cosignReasons = collectCosignReasons(input, coldStartCosign);

  return {
    decision,
    basis,
    requiresCosign: cosignReasons.length > 0,
    cosignReasons,
    matrixCell: cell,
    matrixDecision,
    limitFlags,
    axis,
    rationale:
      limitFlags.length > 0
        ? `${rationale} ${limitFlags.map((f) => f.label).join(" ")}`
        : rationale,
  };
}

/**
 * The matrix, including the cells where an axis could not be evaluated.
 *
 * An unevaluable axis NEVER silently reads as "low". The two absences want
 * different answers, and conflating them with a low score would certify
 * handoffs on no evidence:
 *
 *   axis 1 unevaluable  -> we know nothing about this EVENT. Never accept.
 *   axis 2 unevaluable  -> cold start. The courier is unjudged, not innocent;
 *                          the operator's signature becomes constitutive.
 *
 * See CLAUDE.md for why the cold-start cell is designed behaviour rather than
 * a fallback.
 */
function applyMatrix(
  inconsistencyEvaluable: boolean,
  patternEvaluable: boolean,
  highInconsistency: boolean,
  highPattern: boolean,
): {
  decision: Decision;
  cell: string;
  basis: VerdictBasis;
  rationale: string;
  coldStartCosign: boolean;
} {
  if (!inconsistencyEvaluable) {
    if (patternEvaluable && highPattern) {
      // The pattern IS the evidence. Row 2 does not need this event to be
      // readable — the courier's distribution is what is being questioned.
      return {
        decision: "escalate",
        cell: "unevaluable-single/high-pattern",
        basis: "insufficient_evidence",
        rationale:
          "This event carried too little evidence to check, and this courier's recent pattern is already under question.",
        coldStartCosign: false,
      };
    }

    // We cannot say anything about the event. Accepting would be certifying on
    // no evidence; escalating would accuse a courier over a flat battery.
    return {
      decision: "flag",
      cell: "unevaluable-single",
      basis: "insufficient_evidence",
      rationale: "This event carried too little evidence to check. More is needed before it can be accepted.",
      coldStartCosign: false,
    };
  }

  if (!patternEvaluable) {
    if (highInconsistency) {
      // Something is wrong with this event, but there is no baseline against
      // which to accuse the courier of a habit. Ask about the event.
      return {
        decision: "flag",
        cell: "high-single/cold-start",
        basis: "single_event_only",
        rationale:
          "This handoff is inconsistent, and the courier has too little history to say whether it is typical of them.",
        coldStartCosign: true,
      };
    }

    // COLD START, clean event. Not an accept on a full picture: the machine
    // cannot judge this courier yet, so a human signature is made part of the
    // credential rather than a low score being invented on their behalf.
    return {
      decision: "accept",
      cell: "low-single/cold-start",
      basis: "single_event_only",
      rationale:
        "This handoff looks clean, but the courier has too little history for a pattern check. An operator co-signature is required.",
      coldStartCosign: true,
    };
  }

  if (highInconsistency && highPattern) {
    return {
      decision: "freeze",
      cell: "high-single/high-pattern",
      basis: "both_axes",
      rationale: "This handoff is inconsistent AND fits a pattern already under question.",
      coldStartCosign: false,
    };
  }

  if (highInconsistency) {
    return {
      decision: "flag",
      cell: "high-single/low-pattern",
      basis: "both_axes",
      rationale:
        "This handoff contradicts itself, but the courier's wider record is normal — most likely a device or environment problem. More evidence needed.",
      coldStartCosign: false,
    };
  }

  if (highPattern) {
    // THE SIGNATURE CASE. Every event this courier submits passes on its own.
    // The shape of them, taken together, does not.
    return {
      decision: "escalate",
      cell: "low-single/high-pattern",
      basis: "both_axes",
      rationale:
        "Nothing is wrong with this individual handoff. The pattern across this courier's recent work is wrong, which is not something any single handoff would show.",
      coldStartCosign: false,
    };
  }

  return {
    decision: "accept",
    cell: "low-single/low-pattern",
    basis: "both_axes",
    rationale: "Nothing inconsistent in this handoff, and nothing unusual in the courier's recent record.",
    coldStartCosign: false,
  };
}

const ev = (field: string, value: unknown): Evidence => ({ field, value });

/**
 * Mandate limits and cooldown.
 *
 * L1 (shift limit) is a HARD STOP. Per the mandate design, a valid co-signature
 * does not lift it: an operator can authorise a risky handoff, not a fifteenth
 * hour of driving.
 */
function checkLimits(input: GateInput): Flag[] {
  const { mandate, shift, parcel } = input;
  if (!mandate) return [];

  const flags: Flag[] = [];

  if (shift && shift.handoffsThisShift >= mandate.limits.maxHandoffsPerShift) {
    flags.push({
      id: "L1",
      points: 0,
      label: "The courier has reached the maximum handoffs allowed in one shift.",
      evidence: [
        ev("shift.handoffsThisShift", shift.handoffsThisShift),
        ev("mandate.limits.maxHandoffsPerShift", mandate.limits.maxHandoffsPerShift),
      ],
    });
  }

  if (parcel && parcel.codAmountSen > mandate.limits.codCashCapSen) {
    flags.push({
      id: "L2",
      points: 0,
      label: "The cash-on-delivery amount is above this courier's limit.",
      evidence: [
        ev("parcel.codAmountSen", parcel.codAmountSen),
        ev("mandate.limits.codCashCapSen", mandate.limits.codCashCapSen),
      ],
    });
  }

  if (parcel && parcel.declaredValueSen > mandate.limits.maxParcelValueSen) {
    flags.push({
      id: "L3",
      points: 0,
      label: "The parcel's declared value is above this courier's limit.",
      evidence: [
        ev("parcel.declaredValueSen", parcel.declaredValueSen),
        ev("mandate.limits.maxParcelValueSen", mandate.limits.maxParcelValueSen),
      ],
    });
  }

  if (shift?.lastHighRiskHandoffAt && mandate.cooldownSeconds > 0) {
    const elapsedMs = Date.parse(shift.now) - Date.parse(shift.lastHighRiskHandoffAt);
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < mandate.cooldownSeconds * 1000) {
      flags.push({
        id: "L4",
        points: 0,
        label: "This handoff came too soon after the courier's last high-risk one.",
        evidence: [
          ev("shift.lastHighRiskHandoffAt", shift.lastHighRiskHandoffAt),
          ev("shift.now", shift.now),
          ev("mandate.cooldownSeconds", mandate.cooldownSeconds),
          ev("computed.elapsedSeconds", Math.round(elapsedMs / 1000)),
        ],
      });
    }
  }

  return flags;
}

/**
 * How severe each limit breach is.
 *
 * L1 freezes: a shift ceiling is a stop, and stopping a courier taking further
 * handoffs is precisely what freezing their scope means. L2/L3 escalate — a
 * value ceiling wants a supervisor, not a shutdown. L4 flags.
 */
function decisionForLimit(id: string): Decision {
  switch (id) {
    case "L1":
      return "freeze";
    case "L2":
    case "L3":
      return "escalate";
    default:
      return "flag";
  }
}

/**
 * Whether a courier-signed token alone may verify this handoff.
 *
 * Not a review flag. When this is true the courier's signature is
 * cryptographically insufficient, and the operator's signature is part of what
 * makes the credential valid. See CLAUDE.md.
 */
function collectCosignReasons(input: GateInput, coldStart: boolean): string[] {
  const reasons: string[] = [];

  if (coldStart) {
    reasons.push("The courier has too little history for a pattern check.");
  }

  const mandate = input.mandate;
  if (!mandate) return reasons;

  for (const condition of mandate.requiresCosignIf) {
    switch (condition.kind) {
      case "parcel_value_over_sen":
        if (input.parcel && input.parcel.declaredValueSen > condition.value) {
          reasons.push("The parcel's declared value is above the co-signature threshold.");
        }
        break;
      case "recipient_address_not_in_scope":
        if (input.parcel && !input.parcel.recipientAddressInScope) {
          reasons.push("The recipient address is outside the courier's assigned route.");
        }
        break;
      case "inconsistency_score_at_least":
        if (input.inconsistency.score >= condition.value) {
          reasons.push("This handoff's inconsistency score is above the co-signature threshold.");
        }
        break;
      case "pattern_score_at_least":
        // Reads axis 2 alone. Note it is compared against its OWN threshold —
        // the two axes are never added together to reach one.
        if (!input.pattern.coldStart && input.pattern.score >= condition.value) {
          reasons.push("The courier's pattern score is above the co-signature threshold.");
        }
        break;
    }
  }

  return reasons;
}

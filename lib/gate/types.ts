import type { Flag } from "@/lib/engine/types";
import type { EngineResult } from "@/lib/engine/types";
import type { PatternOutcome } from "@/lib/pattern/types";
import type { CourierMandate } from "@/lib/mandate/schema";
import type { Decision, VerdictBasis } from "@/lib/ledger/types";
import type { GateThresholds } from "./thresholds";

/**
 * The gate: the ONLY place the two axes meet.
 *
 * It receives them as two separate objects and must keep them that way. There
 * is no field on this input, and no field on its output, that holds the two
 * scores added together — a purity test asserts as much. See CLAUDE.md.
 */

/** Shift state the mandate limits are checked against. Assembled by the caller. */
export type ShiftContext = {
  /** Handoffs this courier has already completed this shift. */
  handoffsThisShift: number;
  /** When the courier's last high-risk handoff was sealed, if there was one. */
  lastHighRiskHandoffAt?: string;
  /** This event's time, for the cooldown comparison. */
  now: string;
};

/** What the parcel is worth, for the co-sign conditions. */
export type ParcelValue = {
  declaredValueSen: number;
  codAmountSen: number;
  /** True when the recipient address is outside the mandate's scope. */
  recipientAddressInScope: boolean;
};

export type GateInput = {
  /** Axis 1. Produced at `verify`. */
  inconsistency: EngineResult;
  /** Axis 2. Produced at `fetch_history`. */
  pattern: PatternOutcome;

  mandate?: CourierMandate;
  shift?: ShiftContext;
  parcel?: ParcelValue;

  thresholds: GateThresholds;
};

export type GateResult = {
  decision: Decision;
  /**
   * Whether the decision rests on both axes, one, or neither. Without this,
   * an accept made on a full evidence picture and an accept made because a
   * courier is new look identical in the record.
   */
  basis: VerdictBasis;

  /**
   * True when a courier-signed token alone must NOT verify for this handoff.
   * Not a review flag: the operator's signature is part of the credential.
   */
  requiresCosign: boolean;
  /** Why a co-sign is required, in operator-readable terms. */
  cosignReasons: string[];

  /** Which quadrant of the matrix produced the decision, before limit checks. */
  matrixCell: string;
  /** The decision the matrix alone produced, before limits raised it. */
  matrixDecision: Decision;

  /** Limit and cooldown failures, as flags. Empty when none fired. */
  limitFlags: Flag[];

  /**
   * The two axes, kept apart. Deliberately NOT a single combined number:
   * summing them makes the low-single/high-pattern quadrant unreachable.
   */
  axis: {
    inconsistencyScore: number;
    patternScore: number;
    inconsistencyEvaluable: boolean;
    patternEvaluable: boolean;
  };

  /** Human-readable one-liner for the operator console. */
  rationale: string;
};

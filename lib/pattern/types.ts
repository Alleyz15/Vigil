import type { BizStep, GeoPoint } from "@/lib/epcis";
import type { Evidence, Flag, RuleResult } from "@/lib/engine/types";
import type { PatternThresholds } from "./thresholds";

/**
 * Axis 2 of the orthogonal gate: per-courier rolling pattern.
 *
 * A SEPARATE AXIS, not more evidence for axis 1. Axis 1 asks "is this event
 * self-consistent?"; axis 2 asks "is this courier's behaviour the right shape?".
 * A fraudster careful enough to keep every single event under the threshold
 * still cannot change their own distribution — that is the case no per-event
 * system can see, and the reason the two are never summed. See CLAUDE.md.
 *
 * Pure, like lib/engine/. The caller assembles PatternInput; rules do arithmetic.
 */

export type { Evidence, Flag, RuleResult };

/** One prior handoff by this courier, as the caller resolved it from the DB. */
export type PastHandoff = {
  eventID: string;
  eventTime: string;
  bizStep?: BizStep;
  /** Axis 1 score recorded for that event. Used by P3; never summed with axis 2. */
  inconsistencyScore: number;
  /** Flag ids that fired on that event, e.g. ["I4", "I10"]. Used by P5. */
  flagIds: string[];
  /** Where the scan happened. Used by P4. */
  scanPoint?: GeoPoint;
  /** Where the parcel was actually addressed. P4's contradiction needs both. */
  recipientPoint?: GeoPoint;
  /** "Delivered but the customer says it never arrived." Used by P2. */
  disputed?: boolean;
};

/** Fleet-wide comparison figures, supplied by the caller. */
export type QueueBaseline = {
  /** Dispute rate across the comparable queue, as a fraction (0.02 = 2%). */
  disputeRate: number;
  /** How many handoffs that rate was computed from. */
  sampleSize: number;
};

export type PatternInput = {
  courierId: string;
  /** The rolling window the caller selected handoffs from. */
  window: { from: string; to: string };
  /** Prior handoffs in the window, oldest first. */
  handoffs: PastHandoff[];
  /** Absent when the caller has no comparable queue; P2 then reports not_evaluated. */
  queueBaseline?: QueueBaseline;
  thresholds: PatternThresholds;
};

/** Axis 2's output. Mirrors EngineResult so the gate reads both the same way. */
export type PatternOutcome = {
  /**
   * True when the courier has too little history for ANY pattern claim.
   * The gate treats this as a distinct outcome — never as a low score.
   * A cold-start courier is unjudged, not judged innocent. See CLAUDE.md.
   */
  coldStart: boolean;
  /** Set when coldStart, naming what was missing. */
  coldStartReason?: string;

  flags: Flag[];
  rawScore: number;
  /** rawScore clamped to thresholds.scoreCap. This is axis 2. */
  score: number;
  /** How many handoffs the window actually contained. Thin history is a caveat. */
  sampleSize: number;

  coverage: {
    evaluated: number;
    total: number;
    notEvaluated: { id: string; reason: string }[];
  };
};

/** One entry in the P-rule registry. */
export type PatternRuleEntry = {
  ids: string[];
  run: (input: PatternInput) => RuleResult;
};

export const evidence = (field: string, value: unknown): Evidence => ({ field, value });

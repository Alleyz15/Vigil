/**
 * Axis 2 thresholds: every number the pattern engine uses, with its source.
 *
 * Same discipline as lib/engine/thresholds.ts — experiment 6 sweeps these
 * programmatically, so no rule may contain a literal.
 */

export type PatternThresholds = {
  /**
   * Below this many handoffs in the window, the WHOLE axis reports
   * not_evaluated. A courier with eight deliveries has no distribution; any
   * "pattern score" computed from that is noise wearing a number's clothes.
   *
   * Source: arbitrary but deliberately conservative. Set low enough that a
   * courier reaches a usable baseline within roughly one shift, high enough
   * that a handful of events cannot manufacture a pattern. Cold start is a
   * documented blind spot; see CLAUDE.md for what the gate does about it.
   */
  minHandoffsForPattern: number;

  p1: {
    /** Rolling window for the burst check, in minutes. */
    windowMinutes: number;
    /**
     * Deliveries inside that window above which the burst is implausible.
     *
     * Source: a courier in dense Klang Valley housing needs 2-4 minutes per
     * drop including parking and the doorstep interaction. Eight in ten
     * minutes implies 75 seconds each, sustained — the shape of scanning a
     * vehicle-load as "delivered" and distributing afterwards.
     */
    maxDeliveriesInWindow: number;
    points: number;
  };

  p2: {
    /**
     * Courier dispute rate must exceed the queue baseline by this factor.
     * Source: arbitrary. A multiplier rather than an absolute rate, because
     * the honest baseline varies by route, season and product mix, and a fixed
     * percentage would punish couriers on inherently harder routes.
     */
    baselineMultiplier: number;
    /**
     * Minimum disputes before the rate means anything. Without this, one
     * dispute in twelve handoffs reads as 8% against a 2% baseline and flags
     * a courier for a single unhappy customer.
     */
    minDisputes: number;
    points: number;
  };

  p3: {
    /**
     * Minimum handoffs before a variance estimate is worth computing.
     * Source: a sample standard deviation from fewer than ~20 points has a
     * confidence interval wide enough to be useless.
     */
    minSamples: number;
    /**
     * THE MEAN CONDITION. P3 fires only on low variance around a NON-ZERO
     * mean. A courier scoring 0,0,0,0,0 has a standard deviation of zero and
     * would trip a naive low-variance rule — flagging the cleanest courier in
     * the fleet. Never relax this. See CLAUDE.md.
     */
    minMeanScore: number;
    /**
     * Sample standard deviation below which the distribution is suspiciously
     * tight. Source: honest inconsistency scores are driven by uncorrelated
     * environmental noise (GPS quality, signal, timing) and spread widely. A
     * courier holding station a few points under a threshold does not.
     */
    maxStdDev: number;
    points: number;
  };

  p4: {
    /** Minimum deliveries with known coordinates before clustering means anything. */
    minSamples: number;
    /** Radius in metres within which two scan points count as the same place. */
    clusterRadiusMeters: number;
    /**
     * Fraction of scans that must fall in one cluster to look like batch
     * scanning. Source: arbitrary; 0.7 leaves room for a courier who
     * legitimately works one street.
     */
    minClusteredFraction: number;
    /**
     * The CONTRADICTION. Scans clustered AND recipient addresses clustered is
     * a condo tower, not fraud. Only clustered scans against SPREAD addresses
     * is the batch-scan shape. This is the minimum spread, in metres, that the
     * recipient addresses must show before the rule will fire.
     * Source: comfortably beyond a single building's footprint.
     */
    minRecipientSpreadMeters: number;
    points: number;
  };

  p5: {
    /** How many recent handoffs to inspect. */
    lookback: number;
    /**
     * Fraction of them carrying the SAME flag id before it counts as a
     * recurring signature rather than coincidence.
     * Source: arbitrary. One repeated contradiction across half a courier's
     * recent work is a method, not an accident.
     */
    minRecurrenceFraction: number;
    /** Minimum occurrences, so a short window cannot trip the fraction alone. */
    minOccurrences: number;
    points: number;
  };

  /** Pattern score ceiling. Summed, then clamped. */
  scoreCap: number;
};

export const DEFAULT_PATTERN_THRESHOLDS: PatternThresholds = Object.freeze({
  minHandoffsForPattern: 10,
  p1: Object.freeze({ windowMinutes: 10, maxDeliveriesInWindow: 8, points: 25 }),
  p2: Object.freeze({ baselineMultiplier: 3, minDisputes: 3, points: 40 }),
  p3: Object.freeze({ minSamples: 20, minMeanScore: 5, maxStdDev: 3, points: 20 }),
  p4: Object.freeze({
    minSamples: 10,
    clusterRadiusMeters: 50,
    minClusteredFraction: 0.7,
    minRecipientSpreadMeters: 300,
    points: 30,
  }),
  p5: Object.freeze({ lookback: 20, minRecurrenceFraction: 0.5, minOccurrences: 4, points: 25 }),
  scoreCap: 100,
}) as PatternThresholds;

/**
 * Every number the deterministic engine uses, in one place, each with its source.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * 1. Experiment 6 sweeps these programmatically (detection rate vs false-positive
 *    rate across a threshold range). A magic number inlined in a rule cannot be
 *    swept, so no rule may contain a literal threshold.
 * 2. "We chose 120" is a guess. "Malaysian expressway limit 110 km/h plus a GPS
 *    error margin" is a citation. Every value below carries its derivation, and a
 *    value we cannot justify is marked as arbitrary rather than dressed up.
 *
 * Tiered rules (I4/I5, I10/I11) are expressed as BAND TABLES, not nested ifs, so a
 * sweep can vary a single band's edge without restructuring control flow.
 */

/** One band of a tiered rule. Bands are matched worst-first; at most one fires. */
export type Band = {
  /** Flag id emitted when this band matches, e.g. "I4". */
  id: string;
  /** Inclusive lower bound on the measured quantity. */
  atLeast: number;
  points: number;
};

export type Thresholds = {
  gps: {
    /**
     * Max plausible distance between a GPS fix and the centre of an
     * independently-observed positioning source (cell site, WiFi AP) before the
     * two are treated as contradicting each other.
     *
     * Source: a macro cell in a Malaysian urban area covers roughly 1-3 km. We
     * take the generous end and add margin, so only a clear contradiction fires:
     * this rule is worth +40 and must not trip on ordinary cell handover.
     */
     maxCellDisagreementMeters: number;
    /**
     * Same, for a WiFi AP. Indoor APs carry perhaps 50 m of usable range; the
     * bound is loose because we are detecting a contradiction, not positioning.
     */
    maxWifiDisagreementMeters: number;
    /**
     * A fix reporting worse accuracy than this is too vague to contradict
     * anything, so location rules report not_evaluated rather than clear.
     * Source: consumer GNSS in an urban canyon commonly degrades to 50-100 m.
     * This is what keeps S6 (tunnel drift) out of S1 (spoofing) territory.
     */
    unusableAccuracyMeters: number;
  };

  motion: {
    /**
     * Mean |a| - g below this is treated as physically stationary.
     * Source: a handset resting on a car seat still registers road vibration
     * around 0.1-0.3 m/s^2; a device at rest on a desk sits near 0.02.
     */
    stationaryMs2: number;
    /**
     * Displacement over the motion window above this counts as "GPS says moving".
     * Source: 15 m exceeds GPS jitter at rest while remaining below a walking
     * pace over a typical 60 s window.
     */
    movedMeters: number;
  };

  /**
   * Implied speed between the previous event and this one, above which the
   * movement is treated as physically impossible.
   *
   * Source: Malaysian expressway limit is 110 km/h. Adding a margin for GPS
   * error at both endpoints and for short-interval timing noise gives 120.
   * This is the number experiment 6 sweeps from 80 to 160.
   */
  maxImpliedSpeedKmh: number;

  /**
   * Clock divergence bands: |recordTime - eventTime|, in minutes.
   *
   * Source: 5 minutes is roughly where ordinary device clock drift and mobile
   * upload latency stop explaining the gap. 30 minutes cannot be explained by
   * either and indicates the device clock was set, not drifted.
   */
  clockDivergenceBands: Band[];

  /**
   * Distance bands between the scan location and the recipient address.
   *
   * Source: 200 m is about one apartment block or one shophouse row - far enough
   * to mean "not at the door" but survivable as an address-geocoding error.
   * 2 km cannot be a geocoding error; it is a different neighbourhood.
   */
  deliveryDistanceBands: Band[];

  /**
   * Max gap between a photo's EXIF capture time and the event time.
   * Source: arbitrary, chosen to allow a courier to photograph, then walk back to
   * the vehicle and scan. Not derived from data; flagged in Known Limitations.
   */
  maxPhotoAgeMinutes: number;

  battery: {
    /**
     * Claimed travel below this distance cannot say anything about battery use,
     * so the rule reports not_evaluated. Source: arbitrary, set so the rule only
     * speaks about journeys long enough to cost measurable energy.
     */
    minDistanceKm: number;
    /**
     * Battery drop, in percentage points, below which a journey of at least
     * minDistanceKm is treated as energetically implausible.
     * Source: arbitrary. GPS plus screen plus radio over ~30 minutes of driving
     * costs more than a percentage point on any handset we know of. Weakest rule
     * in the set, which is why it scores only +10.
     */
    minDropPercentPoints: number;
  };

  points: {
    /** I1 - positioning channels contradict each other. */
    positionConflict: number;
    /** I2 - accelerometer says still, GPS says moving. */
    motionConflict: number;
    /** I3 - implied speed exceeds the physical maximum. */
    impossibleSpeed: number;
    /** I6 - scan came from a device not bound to this courier. */
    unboundDevice: number;
    /** I7 - the OS reported a mock location provider. */
    mockLocation: number;
    /** I8 - device integrity attestation failed. */
    integrityFailed: number;
    /** I9 - photo EXIF time is inconsistent with the event time. */
    photoTimeMismatch: number;
    /** I12 - per missing proof-of-delivery artefact. */
    missingPodArtefact: number;
    /** I13 - event fell outside the mandate's permitted hours. */
    outsideTimeWindow: number;
    /** I14 - battery use does not match the claimed distance. */
    batteryMismatch: number;
  };

  /** Inconsistency score ceiling. Scores are summed, then clamped to this. */
  scoreCap: number;
};

/**
 * The shipped defaults. Frozen: a rule must never mutate thresholds, and an
 * experiment must pass a modified copy rather than editing the shared object.
 */
export const DEFAULT_THRESHOLDS: Thresholds = Object.freeze({
  gps: Object.freeze({
    maxCellDisagreementMeters: 5_000,
    maxWifiDisagreementMeters: 300,
    unusableAccuracyMeters: 100,
  }),
  motion: Object.freeze({
    stationaryMs2: 0.05,
    movedMeters: 15,
  }),
  maxImpliedSpeedKmh: 120,
  clockDivergenceBands: Object.freeze([
    { id: "I4", atLeast: 30, points: 30 },
    { id: "I5", atLeast: 5, points: 15 },
  ]) as Band[],
  deliveryDistanceBands: Object.freeze([
    { id: "I10", atLeast: 2_000, points: 40 },
    { id: "I11", atLeast: 200, points: 20 },
  ]) as Band[],
  maxPhotoAgeMinutes: 15,
  battery: Object.freeze({
    minDistanceKm: 20,
    minDropPercentPoints: 1,
  }),
  points: Object.freeze({
    positionConflict: 40,
    motionConflict: 40,
    impossibleSpeed: 40,
    unboundDevice: 25,
    mockLocation: 50,
    integrityFailed: 50,
    photoTimeMismatch: 25,
    missingPodArtefact: 15,
    outsideTimeWindow: 20,
    batteryMismatch: 10,
  }),
  scoreCap: 100,
}) as Thresholds;

/**
 * Pick the first matching band. Bands must be ordered worst-first; this is what
 * makes I4 and I5 mutually exclusive, so a 45-minute divergence scores 30 rather
 * than 45. Returns undefined when the measurement clears every band.
 */
export function matchBand(bands: readonly Band[], measurement: number): Band | undefined {
  return bands.find((band) => measurement >= band.atLeast);
}

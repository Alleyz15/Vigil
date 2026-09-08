import { mean, sampleStandardDeviation } from "simple-statistics";
import { distanceMeters } from "@/lib/engine/geo";
import { isDeliveryEvent } from "@/lib/engine/inconsistency";
import type { GeoPoint } from "@/lib/epcis";
import { type Evidence, type PastHandoff, type PatternInput, type PatternRuleEntry, type RuleResult, evidence as ev } from "./types";

/**
 * P1-P5: per-courier pattern rules.
 *
 * EVERY RULE IS A CONTRADICTION BETWEEN SIGNALS, NOT A LONE HEURISTIC.
 * That is the shape every rule in this system takes, and P4 is the clearest
 * illustration: "deliveries are clustered" flags any courier working one condo
 * tower, so the rule instead asks whether the SCAN points are clustered while
 * the RECIPIENT addresses are spread — two signals disagreeing. See CLAUDE.md.
 *
 * Pure. Three-state results, same as axis 1: not_evaluated is never clear.
 */

const triggered = (id: string, points: number, label: string, evidence: Evidence[]): RuleResult => ({
  status: "triggered",
  flag: { id, points, label, evidence },
});
const skip = (reason: string): RuleResult => ({ status: "not_evaluated", reason });
const clear: RuleResult = { status: "clear" };

const deliveries = (handoffs: PastHandoff[]) => handoffs.filter((h) => isDeliveryEvent(h.bizStep));

/**
 * P1 - too many deliveries in too short a window.
 *
 * The shape of scanning a vehicle-load as "delivered" at the kerb and
 * distributing afterwards: the scans arrive at a rate no one can physically
 * walk, and the parcels arrive later, or not at all.
 */
export function p1BurstScanning(input: PatternInput): RuleResult {
  const delivered = deliveries(input.handoffs);
  if (delivered.length === 0) return skip("no delivery events in the window");

  const windowMs = input.thresholds.p1.windowMinutes * 60_000;
  const times = delivered
    .map((h) => Date.parse(h.eventTime))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  if (times.length === 0) return skip("no parsable delivery timestamps");

  // Densest window: slide a right edge, drop everything older than windowMs.
  let left = 0;
  let densest = 0;
  let densestAt = times[0];
  for (let right = 0; right < times.length; right++) {
    while (times[right] - times[left] > windowMs) left++;
    const count = right - left + 1;
    if (count > densest) {
      densest = count;
      densestAt = times[left];
    }
  }

  if (densest <= input.thresholds.p1.maxDeliveriesInWindow) return clear;

  return triggered(
    "P1",
    input.thresholds.p1.points,
    `${densest} deliveries were recorded within ${input.thresholds.p1.windowMinutes} minutes — faster than they could physically be made.`,
    [
      ev("computed.densestWindowCount", densest),
      ev("computed.windowStart", new Date(densestAt).toISOString()),
      ev("thresholds.p1.maxDeliveriesInWindow", input.thresholds.p1.maxDeliveriesInWindow),
    ],
  );
}

/**
 * P2 - "delivered but never received" disputes above the fleet baseline.
 *
 * The one rule grounded in an outcome rather than a sensor: whatever the
 * evidence said at the time, the recipient says the parcel never came.
 */
export function p2DisputeRate(input: PatternInput): RuleResult {
  const baseline = input.queueBaseline;
  if (!baseline) return skip("no queue baseline supplied to compare against");
  if (baseline.sampleSize <= 0) return skip("queue baseline has no sample behind it");

  const delivered = deliveries(input.handoffs);
  if (delivered.length === 0) return skip("no delivery events in the window");

  const disputes = delivered.filter((h) => h.disputed).length;
  if (disputes < input.thresholds.p2.minDisputes) {
    // One unhappy customer is not a rate. Reporting it as one would flag a
    // courier for a single lost parcel.
    return skip(
      `only ${disputes} dispute(s); at least ${input.thresholds.p2.minDisputes} are needed for a rate`,
    );
  }

  const courierRate = disputes / delivered.length;
  const ceiling = baseline.disputeRate * input.thresholds.p2.baselineMultiplier;
  if (courierRate <= ceiling) return clear;

  return triggered(
    "P2",
    input.thresholds.p2.points,
    `Customers report non-delivery on this courier's handoffs far more often than on comparable routes.`,
    [
      ev("computed.courierDisputeRate", Number(courierRate.toFixed(4))),
      ev("queueBaseline.disputeRate", baseline.disputeRate),
      ev("computed.disputes", disputes),
      ev("computed.deliveries", delivered.length),
    ],
  );
}

/**
 * P3 - the distribution of single-event scores is unnaturally tight.
 *
 * WHY THIS RULE EXISTS
 * --------------------
 * A careful fraudster does not produce high-scoring events. They learn where
 * the threshold sits and stay just under it, every time. Honest inconsistency
 * scores are driven by uncorrelated environmental noise — GPS quality, signal,
 * timing, weather — and spread widely. A courier whose scores sit at 25, 26,
 * 24, 25, 27 across forty handoffs is not experiencing noise. They are holding
 * station, and holding station takes deliberate effort.
 *
 * THE TRAP, AND WHY THE MEAN CONDITION IS NOT OPTIONAL
 * ---------------------------------------------------
 * A genuinely excellent courier scores 0, 0, 0, 0, 0. Their standard deviation
 * is ZERO — the tightest distribution available. A naive low-variance rule
 * flags the cleanest courier in the fleet, which would be the single worst
 * false positive this system could produce and would invalidate the S0
 * baseline outright.
 *
 * So P3 requires low variance around a NON-ZERO mean. Never relax the mean
 * condition. See CLAUDE.md.
 */
export function p3LowVariance(input: PatternInput): RuleResult {
  const { minSamples, minMeanScore, maxStdDev, points } = input.thresholds.p3;

  const scores = input.handoffs.map((h) => h.inconsistencyScore);
  if (scores.length < minSamples) {
    return skip(
      `${scores.length} handoffs; a variance estimate needs at least ${minSamples}`,
    );
  }

  const average = mean(scores);
  if (average < minMeanScore) {
    // Consistently clean. This is what a good courier looks like, and it is
    // the outcome the mean condition exists to protect.
    return clear;
  }

  const stdDev = sampleStandardDeviation(scores);
  if (stdDev >= maxStdDev) return clear;

  return triggered(
    "P3",
    points,
    "This courier's results are unusually consistent — sitting just below the alert level rather than varying the way normal conditions produce.",
    [
      ev("computed.meanInconsistencyScore", Number(average.toFixed(2))),
      ev("computed.sampleStdDev", Number(stdDev.toFixed(3))),
      ev("computed.sampleSize", scores.length),
      ev("thresholds.p3.maxStdDev", maxStdDev),
    ],
  );
}

/** Largest pairwise distance in a set of points. */
function spreadMeters(points: GeoPoint[]): number {
  let max = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = distanceMeters(points[i], points[j]);
      if (d > max) max = d;
    }
  }
  return max;
}

/** The largest set of points lying within `radius` of any single member. */
function largestCluster(points: GeoPoint[], radius: number): { size: number; centre: GeoPoint } {
  let best = { size: 0, centre: points[0] };
  for (const candidate of points) {
    const size = points.filter((p) => distanceMeters(candidate, p) <= radius).length;
    if (size > best.size) best = { size, centre: candidate };
  }
  return best;
}

/**
 * P4 - scans clustered in one place while the parcels were addressed all over.
 *
 * THE CONTRADICTION, not the cluster. A courier delivering to one condo tower
 * legitimately produces scans within 50 m of each other — and their recipient
 * addresses are equally clustered, because it is one building. The fraud shape
 * is scans in ONE place while the addresses are SPREAD: parcels marked
 * delivered from the van, in a batch, before being distributed.
 *
 * Requiring both halves is what stops this rule punishing a courier for
 * working a dense route.
 */
export function p4ScanClustering(input: PatternInput): RuleResult {
  const { minSamples, clusterRadiusMeters, minClusteredFraction, minRecipientSpreadMeters, points } =
    input.thresholds.p4;

  const usable = deliveries(input.handoffs).filter((h) => h.scanPoint && h.recipientPoint);
  if (usable.length < minSamples) {
    return skip(
      `${usable.length} deliveries have both scan and recipient coordinates; at least ${minSamples} are needed`,
    );
  }

  const scanPoints = usable.map((h) => h.scanPoint as GeoPoint);
  const recipientPoints = usable.map((h) => h.recipientPoint as GeoPoint);

  const cluster = largestCluster(scanPoints, clusterRadiusMeters);
  const clusteredFraction = cluster.size / scanPoints.length;
  if (clusteredFraction < minClusteredFraction) return clear;

  const recipientSpread = spreadMeters(recipientPoints);
  if (recipientSpread < minRecipientSpreadMeters) {
    // Scans clustered AND addresses clustered: one building. Not fraud.
    return clear;
  }

  return triggered(
    "P4",
    points,
    `${cluster.size} of ${scanPoints.length} deliveries were scanned from effectively the same spot, but the parcels were addressed across a much wider area.`,
    [
      ev("computed.clusteredFraction", Number(clusteredFraction.toFixed(2))),
      ev("computed.clusterCentre", cluster.centre),
      ev("computed.recipientSpreadMeters", Math.round(recipientSpread)),
      ev("thresholds.p4.clusterRadiusMeters", clusterRadiusMeters),
    ],
  );
}

/**
 * P5 - the same contradiction keeps recurring.
 *
 * One I-rule firing is an incident. The same one firing across half a
 * courier's recent handoffs is a method: whatever they are doing, they are
 * doing it the same way every time, and it leaves the same mark.
 */
export function p5RecurringContradiction(input: PatternInput): RuleResult {
  const { lookback, minRecurrenceFraction, minOccurrences, points } = input.thresholds.p5;

  const recent = input.handoffs.slice(-lookback);
  if (recent.length < minOccurrences) {
    return skip(`${recent.length} recent handoffs; at least ${minOccurrences} are needed`);
  }

  const counts = new Map<string, number>();
  for (const handoff of recent) {
    // Count each flag id once per handoff: a rule that fires twice on one
    // event is still one occurrence of that contradiction.
    for (const id of new Set(handoff.flagIds)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  let worst: { id: string; count: number } | undefined;
  for (const [id, count] of counts) {
    if (!worst || count > worst.count) worst = { id, count };
  }

  if (!worst) return clear;

  const fraction = worst.count / recent.length;
  if (worst.count < minOccurrences || fraction < minRecurrenceFraction) return clear;

  return triggered(
    "P5",
    points,
    `The same problem (${worst.id}) has appeared on ${worst.count} of this courier's last ${recent.length} handoffs.`,
    [
      ev("computed.recurringFlagId", worst.id),
      ev("computed.occurrences", worst.count),
      ev("computed.recentHandoffs", recent.length),
      ev("computed.recurrenceFraction", Number(fraction.toFixed(2))),
    ],
  );
}

export const PATTERN_RULES: readonly PatternRuleEntry[] = [
  { ids: ["P1"], run: p1BurstScanning },
  { ids: ["P2"], run: p2DisputeRate },
  { ids: ["P3"], run: p3LowVariance },
  { ids: ["P4"], run: p4ScanClustering },
  { ids: ["P5"], run: p5RecurringContradiction },
];

/** 5 — the denominator in axis 2's coverage line. */
export const TOTAL_PATTERN_CHECKS = PATTERN_RULES.reduce((n, r) => n + r.ids.length, 0);

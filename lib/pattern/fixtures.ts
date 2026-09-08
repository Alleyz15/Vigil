import type { GeoPoint } from "@/lib/epcis";
import { DEFAULT_PATTERN_THRESHOLDS } from "./thresholds";
import type { PastHandoff, PatternInput } from "./types";

/**
 * Axis-2 test fixtures. Not imported by any rule — only by tests.
 *
 * Builders take a count and produce a courier's window, so a test reads as a
 * description of a courier rather than a wall of literals.
 */

export const COURIER_ID = "CR-0042";

const DELIVERING = "urn:epcglobal:cbv:bizstep:delivering" as const;

/** A point offset from a base by roughly `metresNorth` / `metresEast`. */
export function offset(base: GeoPoint, metresNorth: number, metresEast: number): GeoPoint {
  return {
    latitude: base.latitude + metresNorth / 111_320,
    longitude: base.longitude + metresEast / (111_320 * Math.cos((base.latitude * Math.PI) / 180)),
  };
}

export const KL_BASE: GeoPoint = { latitude: 3.1595, longitude: 101.7123 };

export type HandoffSpec = {
  count: number;
  /** Minutes between consecutive handoffs. */
  everyMinutes?: number;
  startAt?: string;
  /** Axis-1 score for each handoff. A function receives the index. */
  score?: number | ((i: number) => number);
  flagIds?: string[] | ((i: number) => string[]);
  scanPoint?: GeoPoint | ((i: number) => GeoPoint);
  recipientPoint?: GeoPoint | ((i: number) => GeoPoint);
  disputedCount?: number;
};

const resolve = <T>(value: T | ((i: number) => T) | undefined, i: number): T | undefined =>
  typeof value === "function" ? (value as (i: number) => T)(i) : value;

/** Build a run of handoffs. */
export function makeHandoffs(spec: HandoffSpec): PastHandoff[] {
  const start = Date.parse(spec.startAt ?? "2026-09-08T08:00:00+08:00");
  const gap = (spec.everyMinutes ?? 15) * 60_000;

  return Array.from({ length: spec.count }, (_, i) => ({
    eventID: `evt-${String(i).padStart(4, "0")}`,
    eventTime: new Date(start + i * gap).toISOString(),
    bizStep: DELIVERING,
    inconsistencyScore: resolve(spec.score, i) ?? 0,
    flagIds: resolve(spec.flagIds, i) ?? [],
    scanPoint: resolve(spec.scanPoint, i),
    recipientPoint: resolve(spec.recipientPoint, i),
    disputed: i < (spec.disputedCount ?? 0),
  }));
}

export function makePatternInput(over: Partial<PatternInput> = {}): PatternInput {
  return {
    courierId: COURIER_ID,
    window: { from: "2026-09-08T00:00:00+08:00", to: "2026-09-08T23:59:59+08:00" },
    handoffs: makeHandoffs({ count: 24 }),
    queueBaseline: { disputeRate: 0.02, sampleSize: 5_000 },
    thresholds: DEFAULT_PATTERN_THRESHOLDS,
    ...over,
  };
}

/**
 * The honest courier: 24 deliveries at a human pace, spread across a route,
 * scanned at the doorstep, scores driven by ordinary environmental noise.
 *
 * Nothing in axis 2 may fire on this. It is the control for every pattern test
 * and the courier the S0 baseline describes.
 */
export function honestCourier(): PatternInput {
  return makePatternInput({
    handoffs: makeHandoffs({
      count: 24,
      everyMinutes: 18,
      // Real noise: mostly clean, occasionally a genuine environmental hiccup.
      score: (i) => [0, 0, 0, 15, 0, 0, 20, 0, 0, 0, 0, 30][i % 12],
      flagIds: (i) => ([3, 6, 11].includes(i % 12) ? ["I11"] : []),
      // Scanned at each doorstep, and the doorsteps are spread along a route.
      scanPoint: (i) => offset(KL_BASE, i * 140, i * 90),
      recipientPoint: (i) => offset(KL_BASE, i * 140, i * 90),
    }),
  });
}

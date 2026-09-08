import { distance, point as turfPoint } from "@turf/turf";
import type { GeoPoint } from "@/lib/epcis";

/**
 * Geo helpers, kept behind this module so no rule imports turf directly.
 *
 * Two reasons. First, turf takes [lng, lat] while every human-facing field in
 * this codebase is latitude-first, and the one place that ordering is inverted
 * should be the one place it can be got wrong. Second, purity: rules stay
 * arithmetic over their inputs, and swapping the geo implementation never
 * touches a rule.
 */

/** Great-circle distance in metres. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  return distance(
    turfPoint([a.longitude, a.latitude]),
    turfPoint([b.longitude, b.latitude]),
    { units: "meters" },
  );
}

/**
 * Speed implied by travelling between two points in the elapsed time, in km/h.
 *
 * Returns undefined when the timestamps are equal or out of order: a zero or
 * negative interval yields an infinite or nonsensical speed, and reporting
 * "impossible movement" on a division by zero would be a false positive
 * manufactured by arithmetic rather than observed in the data.
 */
export function impliedSpeedKmh(
  from: { point: GeoPoint; at: string },
  to: { point: GeoPoint; at: string },
): number | undefined {
  const elapsedMs = Date.parse(to.at) - Date.parse(from.at);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return undefined;

  const metres = distanceMeters(from.point, to.point);
  return metres / 1000 / (elapsedMs / 3_600_000);
}

/** Absolute difference between two ISO instants, in minutes. */
export function minutesBetween(a: string, b: string): number | undefined {
  const ms = Date.parse(a) - Date.parse(b);
  if (!Number.isFinite(ms)) return undefined;
  return Math.abs(ms) / 60_000;
}

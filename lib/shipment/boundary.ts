import { booleanPointInPolygon } from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { Point } from "./depot";

/**
 * Whether a confirmed coordinate is inside the service area.
 *
 * THE SERVICE AREA IS A REAL ADMINISTRATIVE BOUNDARY OR NOTHING. A rectangle
 * drawn around Kuala Lumpur, or the whole Klang Valley standing in for it, would
 * accept points the system has no business claiming to serve and reject none of
 * the ones it should — a boundary that is wrong in a way nobody can see. So a
 * boundary carries its provenance: where it came from, under what licence, and
 * which version, and that version is written onto every snapshot checked
 * against it.
 *
 * NO BOUNDARY, NO ONLINE SHIPMENT. `checkPoint` with no boundary refuses rather
 * than passing everything through — failing closed is rule 3b's instinct. Until
 * a sourced file is confirmed, `service-area.ts` supplies a PLACEHOLDER: a
 * derived service radius around the existing depots, flagged `placeholder`, and
 * described everywhere as "boundary data pending confirmation" — never as the
 * city boundary.
 *
 * The check runs on the server with Turf. A browser-side check is a courtesy to
 * the person clicking; it is never the one that decides.
 */

export type ServiceBoundary = {
  /** Stored on every snapshot, so a later boundary change is attributable. */
  version: string;
  /** Where the geometry came from, and the licence it is used under. */
  source: string;
  licence: string;
  area: Feature<Polygon | MultiPolygon>;
  /**
   * True for the depot-radius stand-in used until a sourced boundary is
   * confirmed. Every surface that shows a checked point must say so; the
   * placeholder is never presented as a city boundary.
   */
  placeholder?: boolean;
};

/** What a surface says about the boundary a point was checked against. */
export function boundaryLabel(boundary: Pick<ServiceBoundary, "placeholder" | "version">): string {
  return boundary.placeholder
    ? "Boundary data pending confirmation — checked against a placeholder service radius around the existing depots, not the Kuala Lumpur city boundary"
    : `Checked against ${boundary.version}`;
}

export type BoundaryCheck =
  | { ok: true; boundaryVersion: string; placeholder: boolean }
  | { ok: false; code: "no_boundary" | "outside" | "invalid_coordinate"; reason: string };

export function isValidCoordinate(point: Point): boolean {
  return (
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180
  );
}

export function checkPoint(point: Point, boundary: ServiceBoundary | null): BoundaryCheck {
  if (!isValidCoordinate(point)) {
    return {
      ok: false,
      code: "invalid_coordinate",
      reason: "The coordinate is not a valid latitude and longitude.",
    };
  }
  if (!boundary) {
    return {
      ok: false,
      code: "no_boundary",
      reason:
        "No service-area boundary is configured, so no point can be accepted. The boundary " +
        "must be a sourced, licensed administrative file; a rectangle is not substituted for it.",
    };
  }
  // Turf takes [longitude, latitude].
  const inside = booleanPointInPolygon([point.longitude, point.latitude], boundary.area);
  if (!inside) {
    return {
      ok: false,
      code: "outside",
      reason: boundary.placeholder
        ? `That point is outside the placeholder service radius (${boundary.version}). Boundary data is pending confirmation, so this is not a statement about the city limits.`
        : `That point is outside the service area (${boundary.version}).`,
    };
  }
  return { ok: true, boundaryVersion: boundary.version, placeholder: Boolean(boundary.placeholder) };
}

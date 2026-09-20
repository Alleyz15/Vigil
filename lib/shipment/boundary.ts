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
   * True for the depot-radius stand-in. Every surface that shows a checked point
   * must say so; the placeholder is never presented as an administrative area.
   */
  placeholder?: boolean;
  /**
   * The ODbL attribution line, carried with the geometry rather than written
   * next to one of the places it is shown. A licence condition that depends on
   * each surface remembering it is a licence condition waiting to be breached.
   */
  attribution?: string;
  /** When the boundary was extracted, so "which version did we check" is answerable. */
  extractedAt?: string;
  /**
   * The administrative units this area is made of, carried WITH the geometry for
   * the same reason the attribution is: the service area is named by listing its
   * members, so a surface that prints the name must read the list rather than
   * keep a copy of it. Absent on the placeholder, which has no members — it is a
   * radius, and saying otherwise would be the fabricated coverage this rule bans.
   */
  members?: string[];
};

/**
 * What a surface says about the boundary a point was checked against.
 *
 * For a real boundary this is the ODbL attribution plus the extraction date —
 * the licence requires the credit, and the date is what makes the check
 * reproducible. For the placeholder it says so plainly.
 */
export function boundaryLabel(
  boundary: Pick<ServiceBoundary, "placeholder" | "version" | "attribution" | "extractedAt">,
): string {
  if (boundary.placeholder) {
    return (
      "Boundary data pending confirmation — checked against a placeholder service radius around " +
      "the existing depots, not an administrative area"
    );
  }
  return boundary.attribution ?? `Checked against ${boundary.version}`;
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

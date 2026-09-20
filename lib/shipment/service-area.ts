import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { circle, multiPolygon } from "@turf/turf";
import { z } from "zod";
import { distanceMeters } from "@/lib/engine/geo";
import { DEPOTS } from "@/lib/generate/route";
import { ADDRESSES } from "@/lib/generate/world";
import type { ServiceBoundary } from "./boundary";
import { depotFor } from "./depot";

/**
 * The service area, and where the online store lives on disk.
 *
 * THE SERVICE AREA IS FOUR ADMINISTRATIVE UNITS, AND IT IS NAMED BY LISTING THEM:
 * Kuala Lumpur Federal Territory, and the Selangor districts of Petaling, Hulu
 * Langat and Sepang. Every cached address and every depot sits in exactly one of
 * them, and nothing else is claimed.
 *
 * IT IS NOT CALLED "KLANG VALLEY" OR "GREATER KUALA LUMPUR". Both officially
 * include Klang and Gombak, which hold no cached address and no depot, so either
 * name would claim coverage this project does not have — a fabricated line-haul
 * committed in a label. The name being the list also makes a future addition
 * loud: add a district and the list no longer matches.
 *
 * `scripts/fetch-kl-boundary.mjs` extracted it once from OpenStreetMap and
 * committed the result; the file is local, so loading it sends nothing anywhere
 * and costs nothing. `VIGIL_SERVICE_AREA=placeholder` falls back to the derived
 * depot-radius stand-in below, so a problem with the real boundary can be
 * stepped around without a deploy, and the two can be compared side by side.
 */

export const SERVICE_AREA_PATH = join(dirname(fileURLToPath(import.meta.url)), "data", "service-area.json");

const Position = z.tuple([z.number(), z.number()]);
const Ring = z.array(Position).min(4);
const Member = z.object({
  relationId: z.number(),
  label: z.string(),
  version: z.number(),
  lastEditedAt: z.string(),
  adminLevel: z.string(),
  areaKm2: z.number(),
  publishedAreaKm2: z.number(),
  publishedSource: z.string(),
  areaDeltaPercent: z.number(),
});

const ServiceAreaFile = z.strictObject({
  version: z.string().min(1),
  source: z.string().min(1),
  licence: z.string().min(1),
  /** Required on a real boundary: ODbL credit is a condition, not a nicety. */
  attribution: z.string().min(1),
  extractedAt: z.string().min(1),
  members: z.array(Member).min(1),
  areaNote: z.string().min(1),
  areaTolerance: z.number(),
  simplifyToleranceDegrees: z.number(),
  areaKm2: z.number(),
  area: z.object({
    type: z.literal("Feature"),
    properties: z.record(z.string(), z.unknown()).nullable(),
    geometry: z.union([
      z.object({ type: z.literal("Polygon"), coordinates: z.array(Ring).min(1) }),
      z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(z.array(Ring).min(1)).min(1) }),
    ]),
  }),
});

/**
 * THE PLACEHOLDER, kept behind `VIGIL_SERVICE_AREA=placeholder`.
 *
 * NOT A CITY BOUNDARY, AND NOT A RECTANGLE. It is a service radius around the
 * three existing depots, and the radius is DERIVED rather than chosen: the
 * distance from the farthest cached address to its nearest depot. So it accepts
 * every place the cached network already serves and roughly that far around
 * each depot, and it claims nothing about where Kuala Lumpur ends — the
 * Subang Jaya depot is outside KL, and so is part of its circle.
 *
 * `placeholder: true` travels with it: the version is stamped onto every
 * snapshot checked against it, and every surface that reports a check says
 * "boundary data pending confirmation" (see `boundaryLabel`).
 */
export const PLACEHOLDER_RADIUS_METRES = Math.max(
  ...ADDRESSES.map((address) => distanceMeters(address, depotFor(address))),
);

const CIRCLE_STEPS = 64;

export function placeholderBoundary(): ServiceBoundary {
  const km = PLACEHOLDER_RADIUS_METRES / 1000;
  // A 64-gon with vertices ON the circle cuts inside it along every chord, and
  // the farthest cached address sits exactly on the circle — measured: it fell
  // outside. Vertices at r / cos(pi/n) make the polygon CONTAIN the circle, so
  // the derived radius means what it says. Geometry, not a tuned margin.
  const vertexKm = km / Math.cos(Math.PI / CIRCLE_STEPS);
  const circles = DEPOTS.map(
    (depot) =>
      circle([depot.longitude, depot.latitude], vertexKm, { steps: CIRCLE_STEPS, units: "kilometers" }).geometry
        .coordinates,
  );
  return {
    version: `placeholder-depot-radius-v1 (${km.toFixed(3)} km around each of ${DEPOTS.length} depots)`,
    source: "derived from the cached address set and the three existing depots; not an administrative boundary",
    licence: "none required — derived from this repository's own cached data",
    area: multiPolygon(circles),
    placeholder: true,
  };
}

/**
 * Read and validate the boundary. A file that is present but malformed is an
 * error, not a missing boundary: failing loudly beats serving an area nobody
 * can vouch for (rule 3b).
 */
/**
 * Which boundary is in force. `placeholder` steps back to the derived stand-in;
 * anything else uses the committed file, falling back only if it is absent.
 */
export function serviceAreaMode(env: Record<string, string | undefined> = process.env): "file" | "placeholder" {
  return env.VIGIL_SERVICE_AREA === "placeholder" ? "placeholder" : "file";
}

export function loadServiceBoundary(
  path: string = SERVICE_AREA_PATH,
  env: Record<string, string | undefined> = process.env,
): ServiceBoundary {
  if (serviceAreaMode(env) === "placeholder" || !existsSync(path)) return placeholderBoundary();
  const parsed = ServiceAreaFile.parse(JSON.parse(readFileSync(path, "utf8")));
  return {
    version: parsed.version,
    source: parsed.source,
    licence: parsed.licence,
    attribution: parsed.attribution,
    extractedAt: parsed.extractedAt,
    area: parsed.area as ServiceBoundary["area"],
  };
}

/** Where the online store lives. Resolved here so the default is reachable by a test (rule 1d). */
export function shipmentStorePath(env: Record<string, string | undefined> = process.env): string {
  return env.VIGIL_SHIPMENT_DB_PATH ?? "./data/db/shipments.db";
}

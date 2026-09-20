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
 * The service-area boundary file, and where the online store lives on disk.
 *
 * NO FILE IS SHIPPED YET. The boundary must be a sourced administrative file
 * with a named licence and version, and the choice of file is waiting on the
 * licence being confirmed. Until it exists `loadServiceBoundary` returns the
 * clearly-labelled placeholder below — never a rectangle, a bounding box, or
 * the Klang Valley, and never presented as the city boundary.
 *
 * The file is local: loading it sends nothing anywhere and costs nothing.
 */

export const SERVICE_AREA_PATH = join(dirname(fileURLToPath(import.meta.url)), "data", "service-area.json");

const Position = z.tuple([z.number(), z.number()]);
const Ring = z.array(Position).min(4);
const ServiceAreaFile = z.strictObject({
  version: z.string().min(1),
  source: z.string().min(1),
  licence: z.string().min(1),
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
 * THE PLACEHOLDER, used until a sourced boundary file is confirmed.
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
export function loadServiceBoundary(path: string = SERVICE_AREA_PATH): ServiceBoundary {
  if (!existsSync(path)) return placeholderBoundary();
  const parsed = ServiceAreaFile.parse(JSON.parse(readFileSync(path, "utf8")));
  return parsed as ServiceBoundary;
}

/** Where the online store lives. Resolved here so the default is reachable by a test (rule 1d). */
export function shipmentStorePath(env: Record<string, string | undefined> = process.env): string {
  return env.VIGIL_SHIPMENT_DB_PATH ?? "./data/db/shipments.db";
}

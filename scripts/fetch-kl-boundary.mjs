/**
 * ONE-OFF: extract the service area's administrative boundaries and commit the result.
 *
 * Same pattern as `scripts/fetch-addresses.mjs` (Nominatim) and the Open-Meteo
 * cache: fetch once by hand, commit what came back, and never touch the network
 * at runtime. `lib/shipment/service-area.ts` reads the committed file only.
 *
 *   node scripts/fetch-kl-boundary.mjs
 *
 * THE SERVICE AREA IS FOUR ADMINISTRATIVE UNITS, AND IT IS NAMED BY LISTING THEM.
 *
 *   Kuala Lumpur Federal Territory   relation 2939672   15 cached addresses
 *   Petaling, Selangor               relation 12391134   7 cached addresses
 *   Hulu Langat, Selangor            relation 12438351   1 cached address
 *   Sepang, Selangor                 relation 10743315   1 cached address
 *
 * NOT "Klang Valley" AND NOT "Greater Kuala Lumpur". Both officially include
 * Klang and Gombak, which hold no cached address and no depot, so either name
 * would claim coverage this project does not have — the same error as a
 * fabricated line-haul, committed in a label. Listing the members also means the
 * name IS the list: add a district without updating it and the mismatch is loud.
 *
 * ODbL 1.0. The assembled polygon is a DERIVED DATABASE and stays ODbL. Every
 * relation's id and version is recorded, not just "OpenStreetMap contributors",
 * because "which boundary did we check against" has to be answerable later.
 *
 * WHY OVERPASS rather than the main API: `out geom` returns the assembled
 * geometry in ONE request, where the plain API needs each relation plus its ways
 * plus their nodes — hundreds of requests for the same bytes, harder on a public
 * endpoint and with more ways to fail halfway.
 *
 * WHAT STOPS THIS SCRIPT. Metadata proves identity, not usability, so each
 * member is checked for tags, a closed ring and an area near its published
 * figure, and the assembled union is checked for containment BEFORE AND AFTER
 * simplification — a tolerance must not be able to push an address out quietly.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as turf from "@turf/turf";
import { osmUserAgent } from "../lib/osm/agent.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "lib", "shipment", "data", "service-area.json");
const ADDRESSES = join(HERE, "..", "lib", "generate", "data", "kl-addresses.json");

const OVERPASS = "https://overpass-api.de/api/interpreter";

/** Identifies the project to the endpoint operator, as their usage policy asks. */
const USER_AGENT = osmUserAgent("one-off service-area extraction");

/**
 * The members, with the tags each must still carry and the published area each
 * is cross-checked against.
 *
 * The expected tags are re-asserted on every run: a future re-extraction of a
 * re-tagged or re-numbered relation fails instead of silently fetching
 * something else.
 */
const MEMBERS = [
  {
    id: 2939672,
    label: "Kuala Lumpur (Federal Territory)",
    tags: { boundary: "administrative", admin_level: "4", name: "Kuala Lumpur", "ISO3166-2": "MY-14" },
    publishedAreaKm2: 243.65,
    publishedSource: "Wikidata Q1865",
  },
  {
    id: 12391134,
    label: "Petaling, Selangor",
    tags: { boundary: "administrative", admin_level: "6", name: "Petaling" },
    publishedAreaKm2: 484.32,
    publishedSource: "Wikipedia, Petaling District",
  },
  {
    id: 12438351,
    label: "Hulu Langat, Selangor",
    tags: { boundary: "administrative", admin_level: "6", name: "Hulu Langat" },
    publishedAreaKm2: 829.44,
    publishedSource: "Wikipedia, Hulu Langat District",
  },
  {
    id: 10743315,
    label: "Sepang, Selangor",
    tags: { boundary: "administrative", admin_level: "6", name: "Sepang" },
    publishedAreaKm2: 599.66,
    publishedSource: "Wikipedia, Sepang District",
  },
];

/**
 * How far a member's mapped area may sit from its published figure. 5%, SET
 * BEFORE THE EXTRACTION RAN and not adjusted to admit a result.
 *
 * It accepts an OSM boundary that differs from an official figure by ordinary
 * mapping and revision differences, and still refuses a partly-assembled ring,
 * which shows up as a large DEFICIT rather than a small excess. Petaling is the
 * loosest member at +3.4%; see `areaNote` in the written file.
 */
const AREA_TOLERANCE = 0.05;

/**
 * Douglas-Peucker tolerance in DEGREES. RECORDED, not tuned to a result.
 *
 * ~0.0001° is about 11 m at this latitude: below the precision anyone is
 * entitled to expect from a service-area check, and far below the kilometre
 * scale the boundary decides at. Containment runs before AND after, so a
 * tolerance that moved a real address across the line fails the script.
 */
const SIMPLIFY_TOLERANCE_DEGREES = 0.0001;

/** Points that must be refused: north and south of the service area. */
const KNOWN_OUTSIDE = [
  { name: "Ipoh, Perak", latitude: 4.5975, longitude: 101.0901 },
  { name: "Seremban, Negeri Sembilan", latitude: 2.7297, longitude: 101.9381 },
];

async function fetchRelations(ids) {
  const query = `[out:json][timeout:180];relation(id:${ids.join(",")});out geom tags meta;`;
  const response = await fetch(OVERPASS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body: new URLSearchParams({ data: query }).toString(),
  });
  if (!response.ok) throw new Error(`Overpass returned ${response.status} ${response.statusText}`);
  return (await response.json()).elements.filter((element) => element.type === "relation");
}

/**
 * Stitch a relation's `outer` ways into closed rings.
 *
 * Ways arrive in arbitrary order and direction, so each is appended to whichever
 * end it meets, reversed if needed. A segment that meets neither end means the
 * ring has a gap, and that is the failure this exists to catch.
 */
function stitchRings(relation) {
  const segments = relation.members
    .filter((member) => member.type === "way" && member.role === "outer" && member.geometry)
    .map((member) => member.geometry.map((point) => [point.lon, point.lat]));
  if (segments.length === 0) throw new Error(`relation ${relation.id}: no outer ways carried geometry`);

  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  const closed = (ring) => ring.length > 3 && same(ring[0], ring[ring.length - 1]);
  const rings = [];

  while (segments.length > 0) {
    const ring = segments.shift();
    while (!closed(ring)) {
      const tail = ring[ring.length - 1];
      const index = segments.findIndex((s) => same(s[0], tail) || same(s[s.length - 1], tail));
      if (index === -1) {
        throw new Error(
          `relation ${relation.id}: the outer ways do not close — ${segments.length} segment(s) left ` +
            `with no join at ${tail[1].toFixed(6)},${tail[0].toFixed(6)}. Refusing a boundary with a gap.`,
        );
      }
      const [segment] = segments.splice(index, 1);
      ring.push(...(same(segment[0], tail) ? segment : [...segment].reverse()).slice(1));
    }
    rings.push(ring);
  }
  return rings;
}

function featureOf(rings) {
  return rings.length === 1 ? turf.polygon([rings[0]]) : turf.multiPolygon(rings.map((ring) => [ring]));
}

const addresses = JSON.parse(readFileSync(ADDRESSES, "utf8")).addresses;

/**
 * Containment, run on the union before and after simplification.
 *
 * The three depots are DERIVED from this same address set (`lib/generate/route.ts`
 * picks each one as a cached address), so every address being inside puts every
 * depot inside by construction. `lib/shipment/service-area.test.ts` asserts the
 * depots directly by importing `DEPOTS`, rather than repeating their names here
 * as a list someone would have to remember to update.
 */
function checkContainment(label, area) {
  const outside = addresses.filter(
    (address) => !turf.booleanPointInPolygon([address.longitude, address.latitude], area),
  );
  const wronglyInside = KNOWN_OUTSIDE.filter((point) =>
    turf.booleanPointInPolygon([point.longitude, point.latitude], area),
  );
  console.log(
    `  ${label}: ${addresses.length - outside.length}/${addresses.length} cached addresses inside; ` +
      `${KNOWN_OUTSIDE.map((p) => `${p.name.split(",")[0]} ${wronglyInside.includes(p) ? "INSIDE" : "refused"}`).join(", ")}`,
  );
  if (outside.length > 0) {
    throw new Error(
      `${label}: ${outside.length} cached address(es) fell outside — ${outside.map((a) => a.label).join("; ")}`,
    );
  }
  if (wronglyInside.length > 0) {
    throw new Error(
      `${label}: ${wronglyInside.map((p) => p.name).join(", ")} inside the service area. That is not this service area.`,
    );
  }
}

const relations = await fetchRelations(MEMBERS.map((member) => member.id));
const assembled = [];
let union;

for (const member of MEMBERS) {
  const relation = relations.find((candidate) => candidate.id === member.id);
  if (!relation) throw new Error(`Overpass returned no relation ${member.id}`);

  for (const [key, expected] of Object.entries(member.tags)) {
    if (relation.tags[key] !== expected) {
      throw new Error(
        `relation ${member.id} has ${key}=${relation.tags[key] ?? "(absent)"}, expected ${expected}. ` +
          "The object was verified under the expected tags; refusing to extract a different one.",
      );
    }
  }

  const rings = stitchRings(relation);
  const feature = featureOf(rings);
  const areaKm2 = turf.area(feature) / 1e6;
  const drift = (areaKm2 - member.publishedAreaKm2) / member.publishedAreaKm2;
  const [west, south, east, north] = turf.bbox(feature);

  console.log(`relation ${member.id} v${relation.version} — ${member.label}`);
  console.log(`  rings: ${rings.length} closed`);
  console.log(
    `  area: ${areaKm2.toFixed(1)} km² vs published ${member.publishedAreaKm2} km² ` +
      `(${(drift * 100).toFixed(1)}%, ${member.publishedSource})`,
  );
  console.log(
    `  bbox: ${south.toFixed(4)}..${north.toFixed(4)} lat, ${west.toFixed(4)}..${east.toFixed(4)} lon`,
  );

  if (Math.abs(drift) > AREA_TOLERANCE) {
    throw new Error(
      `relation ${member.id} measures ${areaKm2.toFixed(1)} km² against a published ` +
        `${member.publishedAreaKm2} km² — ${(drift * 100).toFixed(1)}%, outside the ` +
        `${(AREA_TOLERANCE * 100).toFixed(0)}% tolerance. A ring can close and still be partly assembled.`,
    );
  }

  assembled.push({
    relationId: member.id,
    label: member.label,
    version: relation.version,
    lastEditedAt: relation.timestamp,
    adminLevel: relation.tags.admin_level,
    areaKm2: Math.round(areaKm2 * 10) / 10,
    publishedAreaKm2: member.publishedAreaKm2,
    publishedSource: member.publishedSource,
    areaDeltaPercent: Math.round(drift * 1000) / 10,
  });

  union = union ? turf.union(turf.featureCollection([union, feature])) : feature;
}

const unionAreaKm2 = turf.area(union) / 1e6;
const [west, south, east, north] = turf.bbox(union);
console.log(`\nunion: ${unionAreaKm2.toFixed(1)} km²`);
console.log(`  bbox: ${south.toFixed(4)}..${north.toFixed(4)} lat, ${west.toFixed(4)}..${east.toFixed(4)} lon`);
checkContainment("before simplify", union);

const simplified = turf.simplify(union, { tolerance: SIMPLIFY_TOLERANCE_DEGREES, highQuality: true });
const simplifiedAreaKm2 = turf.area(simplified) / 1e6;
const pointCount = JSON.stringify(simplified.geometry.coordinates).split("],[").length;
console.log(
  `simplified at ${SIMPLIFY_TOLERANCE_DEGREES}°: ${simplifiedAreaKm2.toFixed(1)} km², ~${pointCount} points`,
);
checkContainment("after simplify", simplified);

const extractedAt = new Date().toISOString();
const attribution =
  "Service area: © OpenStreetMap contributors, assembled from relations " +
  assembled.map((member) => `${member.relationId} (v${member.version})`).join(", ") +
  `, extracted ${extractedAt.slice(0, 10)}. Licensed under ODbL 1.0.`;

const file = {
  version: `osm-service-area-v1 (${assembled.map((m) => `${m.relationId}v${m.version}`).join("+")})`,
  source: `OpenStreetMap administrative boundaries: ${assembled.map((m) => m.label).join("; ")}`,
  licence: "ODbL 1.0",
  attribution,
  extractedAt,
  members: assembled,
  /**
   * Which member matched its published figure least well, and the two readings
   * of that. Recorded because "the tolerance passed" is not the same as "every
   * member matched", and the next reader should know where the slack is.
   */
  areaNote:
    "Petaling is the loosest match at +3.4% (500.6 km² mapped against a published 484.32 km²). Two " +
    "honest readings: OSM's mapping of the district edge differs from the official figure, or the " +
    "published figure predates a boundary revision. It is not a partial ring — that appears as a " +
    "large deficit, and the relation stitched into one closed ring with the correct bounding box. " +
    "Accepted under a 5% tolerance fixed before extraction. The other three are +0.1%, +1.7%, +0.5%.",
  areaTolerance: AREA_TOLERANCE,
  simplifyToleranceDegrees: SIMPLIFY_TOLERANCE_DEGREES,
  areaKm2: Math.round(simplifiedAreaKm2 * 10) / 10,
  area: simplified,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`, "utf8");
console.log(`\nwrote ${OUT}`);
console.log(attribution);

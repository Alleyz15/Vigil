/**
 * One-off: fetch real Kuala Lumpur / Selangor addresses from OSM Nominatim and
 * cache them to lib/generate/data/kl-addresses.json.
 *
 * RUN BY HAND, NOT BY THE GENERATOR. The generator reads the cache and must
 * never touch the network: a dataset that changes because a third-party
 * geocoder changed is not reproducible, and reproducibility is the whole point
 * of a seeded generator.
 *
 *   node scripts/fetch-addresses.mjs
 *
 * Nominatim's usage policy asks for at most one request per second and a
 * descriptive User-Agent identifying the application. Both are honoured below.
 * This is a one-off of roughly two dozen requests, not bulk geocoding.
 *
 * If the API is unreachable, the script writes a hand-curated fallback set and
 * records `source: "curated"` IN THE JSON ITSELF, so nobody reading the data
 * has to consult a second document to learn where it came from.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "lib",
  "generate",
  "data",
  "kl-addresses.json",
);

const USER_AGENT =
  "Vigil/0.1 (HackAI 2026 Track 02 student project; synthetic logistics dataset; contact: kflee15@gmail.com)";

/** Places to look up. Real streets and landmarks across the Klang Valley. */
const QUERIES = [
  "Jalan Ampang, Kuala Lumpur, Malaysia",
  "Jalan Bukit Bintang, Kuala Lumpur, Malaysia",
  "Jalan Tun Razak, Kuala Lumpur, Malaysia",
  "Jalan Sultan Ismail, Kuala Lumpur, Malaysia",
  "Jalan Raja Chulan, Kuala Lumpur, Malaysia",
  "Jalan Imbi, Kuala Lumpur, Malaysia",
  "Brickfields, Kuala Lumpur, Malaysia",
  "Bangsar, Kuala Lumpur, Malaysia",
  "Mont Kiara, Kuala Lumpur, Malaysia",
  "Sri Hartamas, Kuala Lumpur, Malaysia",
  "Setapak, Kuala Lumpur, Malaysia",
  "Cheras, Kuala Lumpur, Malaysia",
  "Wangsa Maju, Kuala Lumpur, Malaysia",
  "Kepong, Kuala Lumpur, Malaysia",
  "Jalan Klang Lama, Kuala Lumpur, Malaysia",
  "Petaling Jaya, Selangor, Malaysia",
  "SS15, Subang Jaya, Selangor, Malaysia",
  "Damansara Utama, Petaling Jaya, Selangor, Malaysia",
  "Kota Damansara, Selangor, Malaysia",
  "Shah Alam Seksyen 7, Selangor, Malaysia",
  "Shah Alam Seksyen 13, Selangor, Malaysia",
  "Puchong, Selangor, Malaysia",
  "Ampang Jaya, Selangor, Malaysia",
  "Cyberjaya, Selangor, Malaysia",
];

/** Used when Nominatim is unreachable. Real, hand-checked coordinates. */
const CURATED = [
  { label: "Jalan Ampang, Kuala Lumpur", latitude: 3.1595, longitude: 101.7123 },
  { label: "Jalan Bukit Bintang, Kuala Lumpur", latitude: 3.1466, longitude: 101.7113 },
  { label: "Jalan Tun Razak, Kuala Lumpur", latitude: 3.1653, longitude: 101.7215 },
  { label: "Jalan Sultan Ismail, Kuala Lumpur", latitude: 3.1520, longitude: 101.7075 },
  { label: "Jalan Raja Chulan, Kuala Lumpur", latitude: 3.1479, longitude: 101.7098 },
  { label: "Jalan Imbi, Kuala Lumpur", latitude: 3.1436, longitude: 101.7156 },
  { label: "Brickfields, Kuala Lumpur", latitude: 3.1289, longitude: 101.6841 },
  { label: "Bangsar, Kuala Lumpur", latitude: 3.1290, longitude: 101.6700 },
  { label: "Mont Kiara, Kuala Lumpur", latitude: 3.1725, longitude: 101.6509 },
  { label: "Sri Hartamas, Kuala Lumpur", latitude: 3.1642, longitude: 101.6503 },
  { label: "Setapak, Kuala Lumpur", latitude: 3.1974, longitude: 101.7226 },
  { label: "Cheras, Kuala Lumpur", latitude: 3.1073, longitude: 101.7443 },
  { label: "Wangsa Maju, Kuala Lumpur", latitude: 3.2050, longitude: 101.7370 },
  { label: "Kepong, Kuala Lumpur", latitude: 3.2085, longitude: 101.6350 },
  { label: "Jalan Klang Lama, Kuala Lumpur", latitude: 3.0930, longitude: 101.6690 },
  { label: "Petaling Jaya, Selangor", latitude: 3.1073, longitude: 101.6067 },
  { label: "SS15, Subang Jaya, Selangor", latitude: 3.0778, longitude: 101.5860 },
  { label: "Damansara Utama, Petaling Jaya", latitude: 3.1338, longitude: 101.6210 },
  { label: "Kota Damansara, Selangor", latitude: 3.1526, longitude: 101.5820 },
  { label: "Shah Alam Seksyen 7, Selangor", latitude: 3.0733, longitude: 101.5185 },
  { label: "Shah Alam Seksyen 13, Selangor", latitude: 3.0620, longitude: 101.5340 },
  { label: "Puchong, Selangor", latitude: 3.0280, longitude: 101.6180 },
  { label: "Ampang Jaya, Selangor", latitude: 3.1500, longitude: 101.7600 },
  { label: "Cyberjaya, Selangor", latitude: 2.9213, longitude: 101.6559 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function lookup(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "my");

  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

  const [hit] = await response.json();
  if (!hit) return undefined;

  return {
    label: query.replace(", Malaysia", ""),
    latitude: Number(hit.lat),
    longitude: Number(hit.lon),
    osmDisplayName: hit.display_name,
  };
}

async function main() {
  const addresses = [];
  let source = "nominatim";
  let note = "Geocoded from OpenStreetMap via Nominatim. Data © OpenStreetMap contributors, ODbL.";

  try {
    for (const [i, query] of QUERIES.entries()) {
      // One request per second, per Nominatim's usage policy.
      if (i > 0) await sleep(1100);
      process.stdout.write(`  ${i + 1}/${QUERIES.length} ${query}\n`);
      const hit = await lookup(query);
      if (hit) addresses.push(hit);
    }
    if (addresses.length < QUERIES.length / 2) {
      throw new Error(`only ${addresses.length} of ${QUERIES.length} resolved`);
    }
  } catch (err) {
    process.stdout.write(`\n  Nominatim unavailable (${err.message}); using the curated set.\n`);
    addresses.length = 0;
    addresses.push(...CURATED);
    source = "curated";
    note =
      "Nominatim was unreachable when this file was generated. These are hand-curated real Klang Valley coordinates, NOT geocoder output.";
  }

  const payload = {
    // Provenance lives IN the data, so nobody has to read a second document.
    source,
    note,
    generatedAt: new Date().toISOString(),
    attribution: "© OpenStreetMap contributors, ODbL 1.0",
    count: addresses.length,
    addresses,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`\nWrote ${addresses.length} addresses (source: ${source}) to ${OUT}\n`);
}

await main();

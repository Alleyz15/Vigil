import { createNominatimGeocoder, createSerialQueue, GEOCODE_DEMO_CACHE_DIR } from "@/lib/geocode";
import { MAX_PENDING_LOOKUPS, MIN_REQUEST_INTERVAL_MS } from "@/lib/geocode/runtime";

/**
 * Pre-warm the DEMO geocode cache: `npm run geocode:cache:demo`.
 *
 * Writes into `data/geocode-demo/nominatim/`, the committed directory, and
 * nowhere else. Everything the recorded demo searches for is listed here, so
 * every query that reaches Nominatim on the demo's behalf is one somebody chose
 * and can read — and the recording does not depend on a volunteer service being
 * up on the day.
 *
 * Same adapter, same agent, same one-per-second spacing as the runtime; only
 * the cache directory differs. Entries already present are answered from disk
 * and send nothing, so running this twice costs nothing the second time.
 *
 * WHAT IS SENT: the query strings below, and nothing else.
 */
const SEARCHES = [
  // Inside the service area.
  "Menara Kuala Lumpur",
  "Mid Valley Megamall",
  "Sunway Pyramid",
  // Outside it: the demo shows the refusal naming the four covered units.
  "Putrajaya",
  "Ipoh",
];

async function main() {
  const geo = createNominatimGeocoder({
    cacheDir: GEOCODE_DEMO_CACHE_DIR,
    queue: createSerialQueue({ minIntervalMs: MIN_REQUEST_INTERVAL_MS, maxPending: MAX_PENDING_LOOKUPS }),
  });
  let failed = 0;
  for (const q of SEARCHES) {
    const result = await geo.search({ q });
    if (result.status === "found") {
      process.stdout.write(`${q}: ${result.candidates.length} candidate(s) from ${result.source}\n`);
      for (const c of result.candidates) {
        process.stdout.write(`    ${c.ref}  ${c.latitude}, ${c.longitude}  ${c.label}\n`);
      }
    } else {
      process.stdout.write(`${q}: ${result.reason} — ${result.detail}\n`);
      if (result.reason !== "no_results") failed += 1;
    }
  }
  // A failure is not written to the cache, so a rerun retries it. Say so rather
  // than exiting green with a hole in the demo set.
  if (failed > 0) {
    console.error(`${failed} search(es) got no answer and were not cached; run again later.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

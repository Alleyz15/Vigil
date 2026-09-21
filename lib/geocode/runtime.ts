import { join } from "node:path";
import { createNominatimGeocoder } from "./nominatim";
import { createSerialQueue, type SerialQueue } from "./queue";
import type { Geocoder } from "./types";

/**
 * TWO CACHES, IN TWO DIRECTORIES. The boundary between them is where they
 * live, not which files a `.gitignore` rule happens to catch — an ignore rule is
 * a list, and a list is one more thing to keep in step.
 *
 *   runtime   `data/geocode/nominatim/`       written by whoever uses the page;
 *                                              ignored, never committed
 *   demo      `data/geocode-demo/nominatim/`  written ONLY by
 *                                              `npm run geocode:cache:demo`;
 *                                              committed, read first
 *
 * The demo set exists so a recording does not depend on a volunteer service
 * being up on the day, and so every query the demo makes is one somebody chose
 * to send. Nothing at runtime writes into it.
 */
export const GEOCODE_RUNTIME_CACHE_DIR = join(process.cwd(), "data", "geocode", "nominatim");
export const GEOCODE_DEMO_CACHE_DIR = join(process.cwd(), "data", "geocode-demo", "nominatim");

/** Nominatim's absolute maximum is one per second; a little margin for clock granularity. */
export const MIN_REQUEST_INTERVAL_MS = 1_100;
/** Waiting lookups beyond which a new one is refused at once rather than queued. */
export const MAX_PENDING_LOOKUPS = 4;

type Runtime = { queue: SerialQueue; geocoder: Geocoder; cacheOnly: Geocoder };

/**
 * ONE PER PROCESS, AND ON `globalThis`. Next bundles each route separately, so
 * a module-level singleton would give `/search` and `/reverse` a queue EACH —
 * two queues, two requests a second, a limit broken while every line of this
 * file looks right. Hanging it on `globalThis` also survives HMR, like the
 * workbench.
 */
const holder = globalThis as typeof globalThis & { __vigilGeocode?: Runtime };

function runtime(): Runtime {
  if (!holder.__vigilGeocode) {
    const queue = createSerialQueue({ minIntervalMs: MIN_REQUEST_INTERVAL_MS, maxPending: MAX_PENDING_LOOKUPS });
    const shared = { cacheDir: GEOCODE_RUNTIME_CACHE_DIR, demoCacheDir: GEOCODE_DEMO_CACHE_DIR, queue };
    holder.__vigilGeocode = {
      queue,
      geocoder: createNominatimGeocoder(shared),
      // For reading back what a person already looked up — never sends.
      cacheOnly: createNominatimGeocoder({ ...shared, network: "cache-only" }),
    };
  }
  return holder.__vigilGeocode;
}

/** The application's geocoder: cache first, then the one queue. */
export function geocoder(): Geocoder {
  return runtime().geocoder;
}

/** The same caches, with the network forbidden. Used to verify a label on create. */
export function cachedGeocoder(): Geocoder {
  return runtime().cacheOnly;
}

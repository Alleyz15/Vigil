/**
 * Server-side geocoding. The browser imports `./messages` directly and never
 * this barrel: the adapter reads and writes files with `node:fs`.
 */
export * from "./types";
export * from "./messages";
export * from "./queue";
export * from "./attach";
export { createNominatimGeocoder, NOMINATIM_ORIGIN, NOMINATIM_USER_AGENT } from "./nominatim";
export { geocoder, cachedGeocoder, GEOCODE_DEMO_CACHE_DIR, GEOCODE_RUNTIME_CACHE_DIR } from "./runtime";

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { canonicalHash } from "@/lib/ledger/canonical";
import { osmUserAgent } from "@/lib/osm/agent.mjs";
import { roundCoordinate } from "@/lib/shipment/picker";
import { normaliseQuery } from "./messages";
import { QueueSaturated, type SerialQueue } from "./queue";
import {
  Candidate,
  GeocodeCacheEntry,
  ReverseQuery,
  SearchQuery,
  type AnswerSource,
  type Failed,
  type FailureReason,
  type Geocoder,
  type ReverseLabel,
  type ReverseResult,
} from "./types";

/**
 * Public Nominatim, behind a disk cache and the application's one queue.
 *
 * Modelled on `lib/weather/open-meteo.ts`, with the constraints Nominatim's
 * usage policy adds on top:
 *
 *   ONE UPSTREAM, FIXED. The origin is a constant. Nothing a caller passes can
 *   point a request anywhere else; tests substitute `fetch`, never the URL.
 *
 *   IDENTIFIED. Every request carries `NOMINATIM_USER_AGENT`. The policy says
 *   default agents are blocked, and phase one's tile recorder shipped without
 *   one — so the header is set here, once, and a test reads it off a request
 *   that actually crossed a socket rather than off this file.
 *
 *   CACHE BEFORE QUEUE. A cached answer returns before the queue is touched,
 *   so "a cache hit sends no request" is true by construction, not by a
 *   branch someone could reorder.
 *
 *   BOUNDED RETRY, AND ONLY WHERE IT IS SAFE. One retry, and only when the
 *   request got no answer at all (network failure or 5xx). A timeout is not
 *   retried — the first request may still be running upstream — and a 429 is
 *   never retried: being told to slow down is not a transient fault.
 *
 *   AN HONEST PAUSE AFTER 429. Once Nominatim says slow down, lookups inside
 *   the cool-down answer `rate_limited` without sending anything.
 *
 * NOTHING HERE INVENTS AN ANSWER. Every path that is not a parsed upstream (or
 * cached) response ends in a named failure with no candidates.
 */

export const NOMINATIM_ORIGIN = "https://nominatim.openstreetmap.org";

/**
 * THE REPOSITORY, NOT A PERSON. A runtime caller is triggered by whoever is
 * using the page, whenever they use it, and a header on every search lands in
 * upstream logs, in captures and in every fork's traffic. The policy asks that
 * the application be identifiable and contactable; the repository's issue
 * tracker is that contact. (One-off scripts, run once by their author, answer
 * the same requirement differently — see `scripts/fetch-addresses.mjs`.) The
 * string itself comes from `lib/osm/agent.mjs`, shared by every OSM caller.
 */
export const NOMINATIM_USER_AGENT = osmUserAgent();

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type NominatimOptions = {
  /** Where answers fetched from the network are written. */
  cacheDir: string;
  /** A read-only, committed cache consulted first (the pre-warmed demo set). */
  demoCacheDir?: string;
  queue: SerialQueue;
  fetch?: FetchLike;
  network?: "allow" | "cache-only";
  timeoutMs?: number;
  now?: () => number;
};

const SEARCH_LIMIT = 5;
const MAX_ATTEMPTS = 2;
const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 120_000;

const OsmType = z.enum(["node", "way", "relation"]);
const Place = z.object({
  osm_type: OsmType,
  osm_id: z.number().int().nonnegative(),
  lat: z.string(),
  lon: z.string(),
  display_name: z.string(),
});
const SearchResponse = z.array(Place);
const ReverseResponse = z.union([Place, z.object({ error: z.string() })]);

/** Control characters out, whitespace collapsed, length capped. Shown, never interpreted. */
function cleanLabel(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function toCandidate(place: z.infer<typeof Place>): Candidate | undefined {
  const latitude = Number(place.lat);
  const longitude = Number(place.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  const parsed = Candidate.safeParse({
    ref: `${place.osm_type}/${place.osm_id}`,
    label: cleanLabel(place.display_name),
    latitude: roundCoordinate(latitude),
    longitude: roundCoordinate(longitude),
  });
  return parsed.success ? parsed.data : undefined;
}

export function searchKey(q: string) {
  return { kind: "search" as const, q: normaliseQuery(q) };
}

export function reverseKey(query: ReverseQuery) {
  return {
    kind: "reverse" as const,
    latitude: roundCoordinate(query.latitude),
    longitude: roundCoordinate(query.longitude),
  };
}

export function cachePathFor(dir: string, key: ReturnType<typeof searchKey> | ReturnType<typeof reverseKey>): string {
  return join(dir, `${key.kind}-${canonicalHash(key)}.json`);
}

export function searchUrl(q: string): string {
  const url = new URL("/search", NOMINATIM_ORIGIN);
  url.searchParams.set("q", normaliseQuery(q));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", String(SEARCH_LIMIT));
  url.searchParams.set("countrycodes", "my");
  url.searchParams.set("accept-language", "en");
  return url.toString();
}

export function reverseUrl(query: ReverseQuery): string {
  const key = reverseKey(query);
  const url = new URL("/reverse", NOMINATIM_ORIGIN);
  url.searchParams.set("lat", String(key.latitude));
  url.searchParams.set("lon", String(key.longitude));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("zoom", "18");
  url.searchParams.set("accept-language", "en");
  return url.toString();
}

function readEntry(path: string): GeocodeCacheEntry | undefined {
  try {
    return GeocodeCacheEntry.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function writeEntry(path: string, entry: GeocodeCacheEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.floor(performance.now())}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

type Fetched = { ok: true; body: unknown } | { ok: false; reason: FailureReason; detail: string; retryAfterMs?: number };

function failure(reason: FailureReason, detail: string): Failed {
  return { status: "failed", source: "none", reason, detail };
}

export function createNominatimGeocoder(options: NominatimOptions): Geocoder {
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const network = options.network ?? "allow";
  const timeoutMs = options.timeoutMs ?? 8_000;
  const now = options.now ?? (() => Date.now());
  let coolDownUntil = Number.NEGATIVE_INFINITY;

  const lookupCache = (key: ReturnType<typeof searchKey> | ReturnType<typeof reverseKey>) => {
    const places: Array<[string, AnswerSource]> = [];
    if (options.demoCacheDir) places.push([options.demoCacheDir, "demo_cache"]);
    places.push([options.cacheDir, "cache"]);
    for (const [dir, source] of places) {
      const entry = readEntry(cachePathFor(dir, key));
      if (!entry || entry.kind !== key.kind) continue;
      // The stored query must be the asked query, or the file is not an answer to it.
      const stored = entry.kind === "search" ? { kind: "search", ...entry.query } : { kind: "reverse", ...entry.query };
      if (canonicalHash(stored) !== canonicalHash(key)) continue;
      return { entry, source };
    }
    return undefined;
  };

  /** One attempt, through the queue. The timeout covers the request, not the wait for a turn. */
  const attempt = (url: string): Promise<Fetched> =>
    options.queue.run(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(url, {
          signal: controller.signal,
          headers: { "User-Agent": NOMINATIM_USER_AGENT, Accept: "application/json" },
        });
        if (response.status === 429) {
          const seconds = Number(response.headers.get("retry-after"));
          return {
            ok: false,
            reason: "rate_limited",
            detail: "Nominatim answered HTTP 429 (too many requests).",
            retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_COOLDOWN_MS,
          };
        }
        if (response.status >= 500) {
          return { ok: false, reason: "unreachable", detail: `Nominatim answered HTTP ${response.status}.` };
        }
        if (!response.ok) {
          return { ok: false, reason: "refused", detail: `Nominatim refused the request with HTTP ${response.status}.` };
        }
        try {
          return { ok: true, body: await response.json() };
        } catch {
          return { ok: false, reason: "malformed", detail: "Nominatim's answer was not valid JSON." };
        }
      } catch (error) {
        if (controller.signal.aborted || (error as Error).name === "AbortError") {
          return { ok: false, reason: "timeout", detail: `Nominatim did not answer within ${timeoutMs} ms.` };
        }
        return { ok: false, reason: "unreachable", detail: `Nominatim could not be reached: ${(error as Error).message}` };
      } finally {
        clearTimeout(timer);
      }
    });

  const request = async (url: string): Promise<Fetched> => {
    if (network === "cache-only") {
      return { ok: false, reason: "unreachable", detail: "Not in the cache, and this geocoder is cache-only." };
    }
    if (now() < coolDownUntil) {
      return {
        ok: false,
        reason: "rate_limited",
        detail: "Nominatim asked this application to slow down; no request is sent until the pause ends.",
      };
    }
    let last: Fetched | undefined;
    for (let n = 0; n < MAX_ATTEMPTS; n += 1) {
      try {
        last = await attempt(url);
      } catch (error) {
        if (error instanceof QueueSaturated) {
          return {
            ok: false,
            reason: "rate_limited",
            detail: "Vigil's own one-request-per-second queue is full; this lookup was not sent.",
          };
        }
        throw error;
      }
      if (last.ok || last.reason !== "unreachable") break;
    }
    if (last && !last.ok && last.reason === "rate_limited" && last.retryAfterMs) {
      coolDownUntil = now() + Math.min(last.retryAfterMs, MAX_COOLDOWN_MS);
    }
    return last!;
  };

  return {
    async search(raw) {
      // Invalid input is the CALLER's bug, not an answer — so it throws rather
      // than coming back as "no results". The routes validate before calling.
      const key = searchKey(SearchQuery.parse(raw).q);

      const cached = lookupCache(key);
      if (cached && cached.entry.kind === "search") {
        return cached.entry.candidates.length > 0
          ? { status: "found", source: cached.source, candidates: cached.entry.candidates }
          : { status: "failed", source: cached.source, reason: "no_results", detail: "Cached: no place matched this text." };
      }

      const fetched = await request(searchUrl(key.q));
      if (!fetched.ok) return failure(fetched.reason, fetched.detail);

      const parsed = SearchResponse.safeParse(fetched.body);
      if (!parsed.success) return failure("malformed", "Nominatim's search answer was not a list of places.");
      const candidates = parsed.data.map(toCandidate);
      // WHOLE OR NOTHING: a list with one unreadable place is not trimmed and
      // trusted — the same rule as a model's response (rule 1a).
      if (candidates.some((candidate) => candidate === undefined)) {
        return failure("malformed", "Nominatim returned a place that could not be read.");
      }

      const entry: GeocodeCacheEntry = {
        v: 1,
        provider: "nominatim",
        kind: "search",
        query: { q: key.q },
        fetchedAt: new Date(now()).toISOString(),
        candidates: candidates as Candidate[],
      };
      writeEntry(cachePathFor(options.cacheDir, key), entry);
      return entry.candidates.length > 0
        ? { status: "found", source: "network", candidates: entry.candidates }
        : failure("no_results", "Nominatim found no place matching this text.");
    },

    async reverse(raw) {
      const query = ReverseQuery.parse(raw);
      const key = reverseKey(query);
      // The clicked coordinate, handed back exactly as received. Never the
      // object Nominatim found.
      const at = { latitude: query.latitude, longitude: query.longitude };

      const answer = (found: ReverseLabel | null, source: AnswerSource): ReverseResult =>
        found
          ? { status: "found", source, at, found }
          : { status: "failed", source, reason: "no_results", detail: "No address is known at this point." };

      const cached = lookupCache(key);
      if (cached && cached.entry.kind === "reverse") return answer(cached.entry.found, cached.source);

      const fetched = await request(reverseUrl(key));
      if (!fetched.ok) return failure(fetched.reason, fetched.detail);

      const parsed = ReverseResponse.safeParse(fetched.body);
      if (!parsed.success) return failure("malformed", "Nominatim's reverse answer was not a place.");
      let found: ReverseLabel | null = null;
      if ("osm_type" in parsed.data) {
        const candidate = toCandidate(parsed.data);
        if (!candidate) return failure("malformed", "Nominatim returned a place that could not be read.");
        found = { ref: candidate.ref, label: candidate.label };
      }

      writeEntry(cachePathFor(options.cacheDir, key), {
        v: 1,
        provider: "nominatim",
        kind: "reverse",
        query: { latitude: key.latitude, longitude: key.longitude },
        fetchedAt: new Date(now()).toISOString(),
        found,
      });
      return answer(found, "network");
    },
  };
}

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { canonicalHash } from "@/lib/ledger";
import {
  WeatherCacheEntry,
  WeatherQuery,
  type WeatherProvider,
  type WeatherResult,
} from "./types";
import { wmoLabel } from "./wmo";

const ARCHIVE_ENDPOINT = "https://archive-api.open-meteo.com/v1/archive";

const NumericSeries = z.array(z.number());
const ArchiveResponse = z.object({
  latitude: z.number(),
  longitude: z.number(),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: NumericSeries,
    precipitation: NumericSeries,
    rain: NumericSeries,
    weather_code: NumericSeries,
    wind_speed_10m: NumericSeries,
  }),
});

export type OpenMeteoOptions = {
  cacheDir: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  network?: "allow" | "cache-only";
  timeoutMs?: number;
};

export function normalizeWeatherQuery(input: WeatherQuery): WeatherQuery {
  const query = WeatherQuery.parse(input);
  const date = new Date(query.hour);
  date.setUTCMinutes(0, 0, 0);
  return { ...query, hour: date.toISOString() };
}

/** Exact query tuple -> opaque stable filename. No coordinate rounding. */
export function cachePathFor(cacheDir: string, input: WeatherQuery): string {
  const query = normalizeWeatherQuery(input);
  return join(cacheDir, `${canonicalHash(query)}.json`);
}

function utcHour(input: WeatherQuery): { iso: string; apiHour: string; date: string } {
  const iso = normalizeWeatherQuery(input).hour;
  return { iso, apiHour: iso.slice(0, 13) + ":00", date: iso.slice(0, 10) };
}

function requestUrl(query: WeatherQuery): string {
  const hour = utcHour(query);
  const url = new URL(ARCHIVE_ENDPOINT);
  url.searchParams.set("latitude", String(query.latitude));
  url.searchParams.set("longitude", String(query.longitude));
  url.searchParams.set("start_date", hour.date);
  url.searchParams.set("end_date", hour.date);
  url.searchParams.set(
    "hourly",
    "temperature_2m,precipitation,rain,weather_code,wind_speed_10m",
  );
  // UTC gives an unambiguous cache hour and avoids a timezone lookup becoming
  // another hidden dependency. The event retains its own EPCIS offset.
  url.searchParams.set("timezone", "GMT");
  return url.toString();
}

function readCache(path: string, query: WeatherQuery): WeatherResult | undefined {
  try {
    const entry = WeatherCacheEntry.parse(JSON.parse(readFileSync(path, "utf8")));
    if (canonicalHash(entry.query) !== canonicalHash(query)) return undefined;
    return { status: "available", source: "cache", observation: entry.observation };
  } catch {
    return undefined;
  }
}

function writeCache(path: string, entry: z.infer<typeof WeatherCacheEntry>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Open-Meteo's historical archive behind a disk cache.
 *
 * A network error is data unavailability, not a node failure. The caller gets
 * an explicit reason and continues on the deterministic path.
 */
export function createOpenMeteoProvider(options: OpenMeteoOptions): WeatherProvider {
  const fetchFn = options.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
  const network = options.network ?? "allow";
  const timeoutMs = options.timeoutMs ?? 8_000;

  return {
    async lookup(rawQuery) {
      const query = normalizeWeatherQuery(rawQuery);
      const path = cachePathFor(options.cacheDir, query);
      const cached = readCache(path, query);
      if (cached) return cached;

      if (network === "cache-only") {
        return {
          status: "unavailable",
          source: "none",
          reason: "offline_cache_miss",
          detail: "No cached Open-Meteo observation exists for this location and hour.",
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let raw: unknown;
      try {
        const response = await fetchFn(requestUrl(query), { signal: controller.signal });
        if (!response.ok) {
          return {
            status: "unavailable",
            source: "none",
            reason: "provider_error",
            detail: `Open-Meteo returned HTTP ${response.status}.`,
          };
        }
        raw = await response.json();
      } catch (error) {
        const timedOut = controller.signal.aborted || (error as Error).name === "AbortError";
        return {
          status: "unavailable",
          source: "none",
          reason: timedOut ? "timeout" : "provider_error",
          detail: timedOut
            ? `Open-Meteo did not respond within ${timeoutMs} ms.`
            : `Open-Meteo request failed: ${(error as Error).message}`,
        };
      } finally {
        clearTimeout(timer);
      }

      const parsed = ArchiveResponse.safeParse(raw);
      if (!parsed.success) {
        return {
          status: "unavailable",
          source: "none",
          reason: "malformed_response",
          detail: "Open-Meteo returned data that did not match the hourly archive schema.",
        };
      }

      const wanted = utcHour(query);
      const index = parsed.data.hourly.time.indexOf(wanted.apiHour);
      if (index < 0) {
        return {
          status: "unavailable",
          source: "none",
          reason: "hour_missing",
          detail: `Open-Meteo returned no observation for ${wanted.iso}.`,
        };
      }

      const hourly = parsed.data.hourly;
      const values = [
        hourly.temperature_2m[index],
        hourly.precipitation[index],
        hourly.rain[index],
        hourly.weather_code[index],
        hourly.wind_speed_10m[index],
      ];
      if (values.some((value) => value === undefined || !Number.isFinite(value))) {
        return {
          status: "unavailable",
          source: "none",
          reason: "malformed_response",
          detail: "Open-Meteo returned incomplete values for the requested hour.",
        };
      }

      const weatherCode = hourly.weather_code[index]!;
      const entry = WeatherCacheEntry.parse({
        v: 1,
        provider: "open-meteo-archive",
        endpoint: ARCHIVE_ENDPOINT,
        query: { ...query, hour: wanted.iso },
        observation: {
          requestedLatitude: query.latitude,
          requestedLongitude: query.longitude,
          gridLatitude: parsed.data.latitude,
          gridLongitude: parsed.data.longitude,
          hour: wanted.iso,
          temperatureC: hourly.temperature_2m[index],
          precipitationMm: hourly.precipitation[index],
          rainMm: hourly.rain[index],
          weatherCode,
          windSpeedKmh: hourly.wind_speed_10m[index],
          condition: wmoLabel(weatherCode),
          resolutionKm: 9,
        },
      });
      writeCache(path, entry);
      return { status: "available", source: "network", observation: entry.observation };
    },
  };
}

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachePathFor, createOpenMeteoProvider, type WeatherQuery } from ".";

const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vigil-weather-"));
  dirs.push(dir);
  return dir;
}

const query: WeatherQuery = {
  latitude: 3.1595,
  longitude: 101.7123,
  hour: "2026-09-08T02:00:00.000Z",
};

function response(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
}

function validArchiveResponse() {
  return {
    latitude: 3.125,
    longitude: 101.75,
    generationtime_ms: 0.18,
    utc_offset_seconds: 0,
    timezone: "GMT",
    timezone_abbreviation: "GMT",
    elevation: 56,
    hourly_units: {
      time: "iso8601",
      temperature_2m: "°C",
      precipitation: "mm",
      rain: "mm",
      weather_code: "wmo code",
      wind_speed_10m: "km/h",
    },
    hourly: {
      time: ["2026-09-08T00:00", "2026-09-08T01:00", "2026-09-08T02:00"],
      temperature_2m: [27.1, 26.8, 26.4],
      precipitation: [0, 0.2, 8.6],
      rain: [0, 0.2, 8.6],
      weather_code: [1, 61, 65],
      wind_speed_10m: [4.1, 5.2, 11.4],
    },
  };
}

describe("Open-Meteo historical weather", () => {
  it("reads a cache hit without touching the network", async () => {
    const dir = cacheDir();
    const firstFetch = vi.fn(async () => response(validArchiveResponse()));
    const first = await createOpenMeteoProvider({ cacheDir: dir, fetch: firstFetch }).lookup(query);
    expect(first).toMatchObject({ status: "available", source: "network" });

    const forbiddenFetch = vi.fn(async () => {
      throw new Error("network must not be called on a cache hit");
    });
    const second = await createOpenMeteoProvider({ cacheDir: dir, fetch: forbiddenFetch }).lookup(query);

    expect(second).toEqual({ ...first, source: "cache" });
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(cachePathFor(dir, query), "utf8"))).toMatchObject({
      query,
      observation: { weatherCode: 65, rainMm: 8.6, condition: "Heavy rain" },
    });
  });

  it("fills an uncached hour from the archive endpoint", async () => {
    const fetch = vi.fn(async (requestUrl: string) => {
      expect(requestUrl).toContain("archive-api.open-meteo.com");
      return response(validArchiveResponse());
    });
    const result = await createOpenMeteoProvider({ cacheDir: cacheDir(), fetch }).lookup(query);

    expect(result).toMatchObject({
      status: "available",
      source: "network",
      observation: {
        requestedLatitude: query.latitude,
        requestedLongitude: query.longitude,
        gridLatitude: 3.125,
        gridLongitude: 101.75,
        hour: query.hour,
        temperatureC: 26.4,
        precipitationMm: 8.6,
        rainMm: 8.6,
        weatherCode: 65,
        windSpeedKmh: 11.4,
        condition: "Heavy rain",
        resolutionKm: 9,
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(`${url.origin}${url.pathname}`).toBe("https://archive-api.open-meteo.com/v1/archive");
    expect(url.searchParams.get("start_date")).toBe("2026-09-08");
    expect(url.searchParams.get("end_date")).toBe("2026-09-08");
    expect(url.searchParams.get("timezone")).toBe("GMT");
  });

  it("returns an explicit offline cache miss without fabricating weather", async () => {
    const fetch = vi.fn();
    const result = await createOpenMeteoProvider({
      cacheDir: cacheDir(),
      fetch,
      network: "cache-only",
    }).lookup(query);

    expect(result).toEqual({
      status: "unavailable",
      source: "none",
      reason: "offline_cache_miss",
      detail: "No cached Open-Meteo observation exists for this location and hour.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("times out deterministically", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    );
    const pending = createOpenMeteoProvider({
      cacheDir: cacheDir(),
      fetch,
      timeoutMs: 50,
    }).lookup(query);
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toMatchObject({
      status: "unavailable",
      source: "none",
      reason: "timeout",
    });
  });

  it("rejects a malformed archive response and does not poison the cache", async () => {
    const dir = cacheDir();
    const result = await createOpenMeteoProvider({
      cacheDir: dir,
      fetch: async () => response({ hourly: { time: ["2026-09-08T02:00"] } }),
    }).lookup(query);

    expect(result).toMatchObject({
      status: "unavailable",
      source: "none",
      reason: "malformed_response",
    });
    expect(() => readFileSync(cachePathFor(dir, query), "utf8")).toThrow();
  });
});

import { z } from "zod";

export const WeatherQuery = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** UTC hour, truncated to :00. The cache key includes this value verbatim. */
  hour: z.iso.datetime({ offset: true }),
});
export type WeatherQuery = z.infer<typeof WeatherQuery>;

export const WeatherObservation = z.strictObject({
  requestedLatitude: z.number(),
  requestedLongitude: z.number(),
  /** The centre of the reanalysis grid cell Open-Meteo actually returned. */
  gridLatitude: z.number(),
  gridLongitude: z.number(),
  hour: z.iso.datetime({ offset: true }),
  temperatureC: z.number(),
  precipitationMm: z.number().nonnegative(),
  rainMm: z.number().nonnegative(),
  weatherCode: z.number().int(),
  windSpeedKmh: z.number().nonnegative(),
  /** Deterministic WMO label produced locally, never provider prose. */
  condition: z.string().min(1),
  /** Honest spatial bound for the IFS-era historical reanalysis used here. */
  resolutionKm: z.literal(9),
});
export type WeatherObservation = z.infer<typeof WeatherObservation>;

export const WeatherCacheEntry = z.strictObject({
  v: z.literal(1),
  provider: z.literal("open-meteo-archive"),
  endpoint: z.literal("https://archive-api.open-meteo.com/v1/archive"),
  query: WeatherQuery,
  observation: WeatherObservation,
});
export type WeatherCacheEntry = z.infer<typeof WeatherCacheEntry>;

export type WeatherResult =
  | { status: "available"; source: "cache" | "network"; observation: WeatherObservation }
  | {
      status: "unavailable";
      source: "none";
      reason:
        | "offline_cache_miss"
        | "timeout"
        | "provider_error"
        | "malformed_response"
        | "hour_missing";
      detail: string;
    };

export type WeatherProvider = {
  lookup(query: WeatherQuery): Promise<WeatherResult>;
};

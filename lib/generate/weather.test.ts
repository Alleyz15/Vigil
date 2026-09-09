import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { closeDb } from "@/lib/db/client";
import { canonicalize } from "@/lib/ledger";
import type { WeatherProvider } from "@/lib/weather";
import { buildScenario, buildWorld, createHarness, ingestScenario, makeRng } from ".";

const harnesses: ReturnType<typeof createHarness>[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    closeDb(harness.deps.db);
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

const available: WeatherProvider = {
  lookup: async (query) => ({
    status: "available",
    source: "cache",
    observation: {
      requestedLatitude: query.latitude,
      requestedLongitude: query.longitude,
      gridLatitude: 3.125,
      gridLongitude: 101.75,
      hour: "2026-09-08T02:00:00.000Z",
      temperatureC: 26.4,
      precipitationMm: 8.6,
      rainMm: 8.6,
      weatherCode: 65,
      windSpeedKmh: 11.4,
      condition: "Heavy rain",
      resolutionKm: 9,
    },
  }),
};

const unavailable: WeatherProvider = {
  lookup: async () => ({
    status: "unavailable",
    source: "none",
    reason: "offline_cache_miss",
    detail: "No cached observation exists.",
  }),
};

async function run(weather: WeatherProvider) {
  const seed = "s6-weather-parity";
  const startMs = Date.parse("2026-09-07T14:30:00+08:00");
  const world = buildWorld(seed);
  const scenario = buildScenario("S6", { world, rng: makeRng(seed), startMs });
  const harness = createHarness(world);
  harness.deps.weather = weather;
  harnesses.push(harness);
  return { result: await ingestScenario(scenario, harness), harness };
}

describe("S6 weather corroboration", () => {
  it("selects weather deterministically but seals the same verdict when it is unavailable", async () => {
    const withWeather = await run(available);
    const withoutWeather = await run(unavailable);
    const a = withWeather.result.legs.at(-1)!;
    const b = withoutWeather.result.legs.at(-1)!;

    expect(a.planFromHeuristic).toBe(true);
    expect(a.plan?.tools).toContain("check_traffic_weather");
    expect(a.externalContext).toMatchObject({ status: "available" });
    expect(b.externalContext).toMatchObject({ status: "unavailable" });
    expect(a.decision).toBe("accept");
    expect(canonicalize(a.verdict)).toBe(canonicalize(b.verdict));
    expect(a.explanation).toContain("Corroborating context:");
    expect(withWeather.harness.deps.ledger.verifyChain().valid).toBe(true);
    expect(withoutWeather.harness.deps.ledger.verifyChain().valid).toBe(true);
  }, 15_000);
});

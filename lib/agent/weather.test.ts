import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { canonicalize } from "@/lib/ledger";
import { scriptedProvider } from "@/lib/llm";
import type { WeatherProvider } from "@/lib/weather";
import { makeAgentEvent, resetEventIds, runSigned, seedWorld, type World } from "./fixtures";

const worlds: World[] = [];

afterEach(() => {
  for (const world of worlds.splice(0)) rmSync(world.dir, { recursive: true, force: true });
});

function world(): World {
  const value = seedWorld();
  worlds.push(value);
  return value;
}

const llm = scriptedProvider("weather-plan", {
  plan: { tools: ["check_traffic_weather"], rationale: "Check regional conditions." },
  explain: {
    summary: "Regional rain is consistent with degraded positioning.",
    nextStep: "Review the structured evidence.",
    citations: ["weather", "decision"],
  },
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

describe("external_context", () => {
  it("does not call weather unless the closed plan selected it", async () => {
    resetEventIds();
    const fixture = world();
    const lookup = vi.fn(available.lookup);
    const ctx = await runSigned(makeAgentEvent(), fixture, {
      deps: { ...fixture.deps, weather: { lookup } },
    });

    expect(ctx.plan?.tools).not.toContain("check_traffic_weather");
    expect(lookup).not.toHaveBeenCalled();
    expect(ctx.externalContext).toBeUndefined();
  });

  it("keeps the sealed verdict byte-identical with weather available and unavailable", async () => {
    resetEventIds();
    const withWeather = world();
    const eventA = makeAgentEvent();
    resetEventIds();
    const withoutWeather = world();
    const eventB = makeAgentEvent();

    const a = await runSigned(eventA, withWeather, {
      deps: { ...withWeather.deps, llm: { provider: llm }, weather: available },
    });
    const b = await runSigned(eventB, withoutWeather, {
      deps: { ...withoutWeather.deps, llm: { provider: llm }, weather: unavailable },
    });

    expect(a.externalContext).toMatchObject({ status: "available", retrieval: "cache" });
    expect(b.externalContext).toMatchObject({ status: "unavailable", reason: "offline_cache_miss" });
    expect(canonicalize(a.verdict)).toBe(canonicalize(b.verdict));

    const recordA = withWeather.deps.ledger.readRecords()[0];
    const recordB = withoutWeather.deps.ledger.readRecords()[0];
    expect(recordA?.kind).toBe("verdict");
    expect(recordB?.kind).toBe("verdict");
    if (recordA?.kind !== "verdict" || recordB?.kind !== "verdict") {
      throw new Error("weather parity fixture did not seal verdict records");
    }
    expect(recordA?.payloadHash).toBe(recordB?.payloadHash);
    expect(canonicalize(recordA.verdict)).toBe(canonicalize(recordB.verdict));
  });

  it("contains a throwing provider and continues to the deterministic gate", async () => {
    resetEventIds();
    const fixture = world();
    const ctx = await runSigned(makeAgentEvent(), fixture, {
      deps: {
        ...fixture.deps,
        llm: { provider: llm },
        weather: { lookup: async () => { throw new Error("socket closed"); } },
      },
    });

    expect(ctx.externalContext).toMatchObject({ status: "unavailable", reason: "provider_error" });
    expect(ctx.decision).toBe("accept");
    expect(ctx.ledger?.status).toBe("recorded");
  });
});

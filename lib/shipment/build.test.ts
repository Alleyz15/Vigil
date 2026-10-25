import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildWorld } from "@/lib/generate/world";
import { vigilSignalsOf } from "@/lib/epcis";
import { buildOnlineScenario } from "./build";
import type { ShipmentHistory } from "./store";

const world = buildWorld("online-simulation");
const startMs = Date.parse("2026-10-26T09:00:00+08:00");
const shipmentId = "f6a0861e-441f-4cb5-ae6b-2581c412e879";
const location = (purpose: "origin" | "delivery_reference", latitude: number, longitude: number) => ({
  snapshotId: purpose, shipmentId, purpose, latitude, longitude, addressClaim: purpose,
  source: "map_confirmed" as const, resolvedLabel: null, resolvedBy: null, resolvedRef: null,
  confirmedAt: "2026-10-26T08:00:00+08:00", boundaryVersion: "test-fixture-v1",
});
function history(simulationJson: string | null = null): ShipmentHistory {
  const reference = location("delivery_reference", 3.165, 101.73);
  // This fixture names the complete row at the persistence boundary; generation
  // itself must neither open a store nor mutate it.
  return {
    shipment: {
      shipmentId, idempotencyKey: "unit", requestHash: "unit", originSnapshotId: "origin",
      referenceSnapshotId: "delivery_reference", originDepot: "test-origin", destinationDepot: "test-destination", local: false,
      declaredValueSen: 12000, codAmountSen: 0, recipientChannel: "+60111234567", recipientName: "Unit Recipient",
      demoCondition: "normal", simulationJson, simulationSnapshotJson: null, createdAt: "2026-10-26T08:00:00+08:00",
    },
    origin: location("origin", 3.13, 101.67), originalReference: reference, currentReference: reference, corrections: [],
  };
}
const config = { mode: "randomized", seed: "adapter-manifest-1", version: "signals-v1" } as const;

describe("online simulation adapter", () => {
  it("preserves the legacy normal event bytes", () => {
    const result = buildOnlineScenario(history(), { world, startMs });
    const bytes = JSON.stringify([...result.scenario.warmup, ...result.scenario.timeline].map((b) => b.event));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("1e13edd4546fbd2450966ce12a8c5808020191fd3e7f6a6aa6715e06e2c0aece");
    expect(result.scenario.simulation).toBeUndefined();
  });

  it("consumes stored seed/version, keeps confirmed references, and returns bootstrap parcel/dispute references", () => {
    const input = history(JSON.stringify(config));
    const before = JSON.stringify(input);
    const a = buildOnlineScenario(input, { world, startMs });
    const b = buildOnlineScenario(input, { world, startMs });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.scenario.simulation).toMatchObject(config);
    expect(a.scenario.simulation?.bootstrap?.bootstrapCount).toBe(a.scenario.warmup.length);
    expect(a.scenario.parcels[0].recipientPoint).toEqual({ latitude: 3.165, longitude: 101.73 });
    expect(a.scenario.parcels[0].declaredValueSen).toBe(12000);
    expect(a.scenario.parcels.length).toBeGreaterThan(1);
    expect(JSON.stringify(input)).toBe(before);
    expect(a.scenario.timeline).not.toEqual(buildOnlineScenario(history(), { world, startMs }).scenario.timeline);
  });

  it("leaves the legacy advanced mock control intact and composes it with random mode", () => {
    for (const simulationJson of [null, JSON.stringify(config)]) {
      const input = history(simulationJson);
      input.shipment.demoCondition = "mock_location";
      const result = buildOnlineScenario(input, { world, startMs });
      expect(vigilSignalsOf(result.scenario.timeline.at(-1)!.event)?.gps?.mockLocationProvider).toBe(true);
      expect(result.scenario.timeline.slice(0, -1).every((built) => vigilSignalsOf(built.event)?.gps?.mockLocationProvider === false)).toBe(true);
    }
  });

  it("reports unavailable references and mandate hours without turning unknowns into normal evidence", () => {
    const result = buildOnlineScenario(history(JSON.stringify(config)), { world, startMs });
    expect(result.scenario.simulation?.unavailable?.map((gap) => gap.code)).toEqual(["reference_sites_unregistered", "mandate_hours_unrestricted"]);
    expect(result.scenario.simulation?.history).toBeUndefined();
    expect(result.scenario.simulation?.conditions.some((condition) => condition.code.startsWith("history-"))).toBe(true);
    for (const built of result.scenario.timeline) {
      expect(vigilSignalsOf(built.event)?.cell).toBeUndefined();
      expect(vigilSignalsOf(built.event)?.wifi).toBeUndefined();
    }
    expect(() => buildOnlineScenario(history('{"mode":"randomized"}'), { world, startMs })).toThrow();
  });

  it("rebuilds delivery against the caller's retained start without changing preceding event bytes", () => {
    const input = history(JSON.stringify(config));
    const a = buildOnlineScenario(input, { world, startMs });
    const b = buildOnlineScenario(input, { world, startMs, scan: { latitude: 3.19, longitude: 101.76 } });
    expect(b.scenario.timeline.slice(0, -1)).toEqual(a.scenario.timeline.slice(0, -1));
    expect(b.scenario.parcels[0]).toEqual(a.scenario.parcels[0]);
    const nextDay = buildOnlineScenario(input, { world, startMs: startMs + 86_400_000 });
    for (let i = 0; i < a.scenario.timeline.length; i++) {
      expect(Date.parse(nextDay.scenario.timeline[i].event.eventTime) - Date.parse(a.scenario.timeline[i].event.eventTime)).toBe(86_400_000);
    }
  });
});

import { describe, expect, it } from "vitest";
import { EpcisEvent, vigilSignalsOf } from "@/lib/epcis";
import { buildWorld, prefixFor, addressIndexFor } from "../world";
import { NORMAL_LEGS } from "../timeline";
import { simulationStream } from "./streams";
import { buildSimulationTimeline } from "./signals";
import { buildSimulationHistory } from "./history";

const world = buildWorld("simulation-unit");
const courier = world.couriers[1];
const parcels = world.parcels.filter((p) => p.epc.startsWith(prefixFor(1)));
const startMs = Date.parse("2026-10-26T09:00:00+08:00");
const config = { mode: "randomized", seed: "unit-manifest-1", version: "signals-v1" } as const;
const args = { world, courier, parcel: parcels[0], config, startMs, idPrefix: "B-unit", legs: NORMAL_LEGS };

describe("versioned simulation streams", () => {
  it("isolates named draws and reproduces after another stream was consumed", () => {
    const first = simulationStream(config, "gps").next();
    for (let i = 0; i < 20; i++) simulationStream(config, "photo").next();
    expect(simulationStream(config, "gps").next()).toBe(first);
    expect(simulationStream(config, "photo").next()).not.toBe(first);
    expect(simulationStream({ ...config, seed: "unit-manifest-2" }, "gps").next()).not.toBe(first);
  });
});

describe("shared signal narrative", () => {
  it("reproduces physical facts and condition choices across newly allocated shipment identities", () => {
    const a = buildSimulationTimeline(args);
    const b = buildSimulationTimeline({ ...args, idPrefix: "B-a-new-server-uuid" });
    const physical = (result: typeof a) => ({
      legs: result.legs, conditions: result.conditions,
      events: result.timeline.map((built) => {
        const sensor = vigilSignalsOf(built.event)!;
        return { eventTime: built.event.eventTime, recordTime: built.event.recordTime,
          sensor: { ...sensor, pod: sensor.pod ? { ...sensor.pod,
            photoSha256: undefined, signatureSha256: undefined,
            otp: sensor.pod.otp ? { challengeId: "identity-only", verificationReceiptId: "identity-only" } : undefined,
          } : undefined },
          enrollment: built.identity?.deviceEnrollment,
          otp: built.identity?.otpChallenge ? { ...built.identity.otpChallenge,
            challengeId: undefined, verificationReceiptId: undefined, consumedByEventId: undefined,
          } : undefined };
      }),
    });
    expect(physical(b)).toEqual(physical(a));
    expect(b.timeline[0].event.eventID).not.toBe(a.timeline[0].event.eventID);
  });

  it("reproduces all parsed events, independent sidecars and realized conditions", () => {
    const a = buildSimulationTimeline(args);
    const b = buildSimulationTimeline(args);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.timeline).toHaveLength(6);
    for (const built of a.timeline) {
      expect(EpcisEvent.parse(built.raw)).toEqual(built.event);
      expect(vigilSignalsOf(built.event)?.integrity?.attestationSource).toBe("mocked");
      expect(JSON.stringify(built.event)).not.toContain("recipientChannelFingerprint");
      expect(JSON.stringify(built.event)).not.toContain("deviceEnrollment");
    }
    expect(buildSimulationTimeline({ ...args, config: { ...config, seed: "unit-manifest-2" } }).timeline).not.toEqual(a.timeline);
  });

  it("keeps one clock offset per device and true server receipts when the start changes", () => {
    const a = buildSimulationTimeline(args);
    const b = buildSimulationTimeline({ ...args, startMs: startMs + 86_400_000 });
    const offsets = new Map<string, number>();
    for (let i = 0; i < a.timeline.length; i++) {
      const event = a.timeline[i].event;
      const sensor = vigilSignalsOf(event)!;
      const offset = Date.parse(event.eventTime) - (startMs + a.legs[i].offsetMinutes * 60_000);
      const old = offsets.get(sensor.deviceId!);
      if (old !== undefined) expect(offset).toBe(old);
      offsets.set(sensor.deviceId!, offset);
      expect(sensor.gps?.fixTime).toBe(event.eventTime);
      expect(Date.parse(b.timeline[i].event.eventTime) - Date.parse(event.eventTime)).toBe(86_400_000);
      expect(Date.parse(b.timeline[i].event.recordTime!) - Date.parse(event.recordTime!)).toBe(86_400_000);
    }
  });

  it("preserves the device offset when a sampled delivery interval is compressed", () => {
    for (let i = 1; i <= 24; i++) {
      const result = buildSimulationTimeline({ ...args, config: { ...config, seed: `clock-manifest-${i}` } });
      const offsets = new Map<string, number>();
      result.timeline.forEach((built, index) => {
        const deviceId = vigilSignalsOf(built.event)!.deviceId!;
        const offset = Math.round(Date.parse(built.event.eventTime) - startMs - result.legs[index].offsetMinutes * 60_000);
        if (offsets.has(deviceId)) expect(offset).toBe(offsets.get(deviceId));
        offsets.set(deviceId, offset);
      });
    }
  });

  it("changes only the delivery when a confirmed scan is corrected", () => {
    const a = buildSimulationTimeline(args);
    const b = buildSimulationTimeline({ ...args, scan: { latitude: 3.18, longitude: 101.77 } });
    expect(b.timeline.slice(0, -1)).toEqual(a.timeline.slice(0, -1));
    expect(b.timeline.at(-1)).not.toEqual(a.timeline.at(-1));
    expect(parcels[0].recipientPoint).toEqual(args.parcel.recipientPoint);
  });

  it("omits reference observations unless registered sites were explicitly supplied", () => {
    const result = buildSimulationTimeline(args);
    for (const built of result.timeline) {
      const sensor = vigilSignalsOf(built.event)!;
      expect(sensor.cell).toBeUndefined();
      expect(sensor.wifi).toBeUndefined();
    }
  });

  it("refuses to invent observations from unknown reference IDs", () => {
    const result = buildSimulationTimeline({ ...args, registeredSites: { cell: "502-12-9999-99999", wifi: "aa:bb:cc:dd:ee:ff" } });
    const sensor = vigilSignalsOf(result.timeline.at(-1)!.event)!;
    expect(sensor.cell).toBeUndefined();
    expect(sensor.wifi).toBeUndefined();
  });

  it("retains registered independent radio evidence at delivery only", () => {
    const sites = world.sitesByAddress[addressIndexFor(parcels[0])];
    const result = buildSimulationTimeline({ ...args, registeredSites: sites });
    expect(vigilSignalsOf(result.timeline.at(-1)!.event)?.cell).toBeDefined();
    expect(vigilSignalsOf(result.timeline.at(-1)!.event)?.wifi?.[0].bssid).toBe(sites.wifi);
    expect(vigilSignalsOf(result.timeline[0].event)?.cell).toBeUndefined();
  });
});

describe("bootstrap history is actual evidence", () => {
  it("does not redraw bootstrap facts when the shipment identity changes", () => {
    const a = buildSimulationHistory({ world, courier, parcels, config, startMs, idPrefix: "B-one" });
    const b = buildSimulationHistory({ world, courier, parcels, config, startMs, idPrefix: "B-two" });
    expect(a.parcels).toEqual(b.parcels);
    expect(a.conditions).toEqual(b.conditions);
    expect(a.bootstrap).toEqual(b.bootstrap);
    expect(a.warmup.map((event) => ({ time: event.event.eventTime, sensor: vigilSignalsOf(event.event)?.gps }))).toEqual(
      b.warmup.map((event) => ({ time: event.event.eventTime, sensor: vigilSignalsOf(event.event)?.gps })),
    );
    expect(a.warmup.map((event) => a.disputedEventIds.includes(event.event.eventID))).toEqual(
      b.warmup.map((event) => b.disputedEventIds.includes(event.event.eventID)),
    );
    expect(a.warmup[0].event.eventID).not.toBe(b.warmup[0].event.eventID);
  });

  it("returns unique parcel-backed events and disputed warmup IDs, never scores", () => {
    const result = buildSimulationHistory({ world, courier, parcels, config, startMs, idPrefix: "B-unit" });
    expect(result.warmup.length).toBeGreaterThanOrEqual(32);
    expect(new Set(result.warmup.map((b) => b.event.eventID)).size).toBe(result.warmup.length);
    expect(new Set(result.parcels.map((p) => p.epc)).size).toBe(result.warmup.length);
    const ids = new Set<string>(result.warmup.map((b) => b.event.eventID));
    for (const id of result.disputedEventIds) expect(ids.has(id)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("inconsistencyScore");
    const times = result.warmup.map((b) => Date.parse(b.event.eventTime));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(Math.max(...times)).toBeLessThan(startMs);
    expect(buildSimulationHistory({ world, courier, parcels, config, startMs, idPrefix: "B-unit" })).toEqual(result);
  });

  it("records the actual smaller history when not enough parcels exist", () => {
    const result = buildSimulationHistory({ world, courier, parcels: parcels.slice(0, 4), config, startMs, idPrefix: "B-thin" });
    expect(result.warmup).toHaveLength(4);
    expect(result.bootstrap.bootstrapCount).toBe(4);
  });
});

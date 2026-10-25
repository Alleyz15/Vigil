import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { epcsOf, vigilSignalsOf } from "@/lib/epcis";
import { INCONSISTENCY_RULES, i1PositionConflict, i13OutsideTimeWindow } from "@/lib/engine/inconsistency";
import { DEFAULT_THRESHOLDS } from "@/lib/engine/thresholds";
import { runInconsistencyEngine } from "@/lib/engine/engine";
import type { EngineInput, RuleResult } from "@/lib/engine/types";
import { PATTERN_RULES } from "@/lib/pattern/rules";
import { runPatternEngine } from "@/lib/pattern/pattern";
import { DEFAULT_PATTERN_THRESHOLDS } from "@/lib/pattern/thresholds";
import type { PatternInput } from "@/lib/pattern/types";
import { recipientChannelFingerprint } from "@/lib/identity/channel";
import { buildWorld, prefixFor, addressIndexFor, type GeneratedParcel } from "../world";
import { NORMAL_LEGS, type BuiltEvent } from "../timeline";
import { buildSimulationTimeline } from "./signals";
import { buildSimulationHistory } from "./history";
import { offsetPoint } from "../rng";

// Fixed before running the batch. Retain every seed/result, including errors.
const MANIFEST = Array.from({ length: 24 }, (_, i) => `capability-${String(i + 1).padStart(2, "0")}`);
const world = buildWorld("simulation-capabilities");
const courier = world.couriers[1];
const parcels = world.parcels.filter((p) => p.epc.startsWith(prefixFor(1)));
const startMs = Date.parse("2026-10-26T09:00:00+08:00");
const configFor = (seed: string) => ({ mode: "randomized", seed, version: "signals-v1" }) as const;

function input(built: BuiltEvent, parcel: GeneratedParcel, previous?: BuiltEvent): EngineInput {
  const sensor = vigilSignalsOf(built.event);
  const last = previous && vigilSignalsOf(previous.event);
  const cellId = sensor?.cell && `${sensor.cell.mcc}-${sensor.cell.mnc}-${sensor.cell.lac}-${sensor.cell.cellId}`;
  const cell = world.referenceSites.find((s) => s.siteId === cellId);
  const wifi = world.referenceSites.filter((s) => sensor?.wifi?.some((w) => w.bssid === s.siteId));
  return {
    event: built.event, sensor, courier: { courierId: courier.courierId, boundDeviceId: courier.deviceId },
    mandate: courier.mandate,
    parcel: { epc: parcel.epc, recipientPoint: parcel.recipientPoint, recipientChannelFingerprint: recipientChannelFingerprint(parcel.recipientPhone) },
    deviceEnrollment: built.identity?.deviceEnrollment, otpChallenge: built.identity?.otpChallenge,
    previous: previous ? { eventTime: previous.event.eventTime, point: last?.gps?.point, batteryPercent: last?.battery?.levelPercent } : undefined,
    referenceSites: { cell: cell ? { id: cell.siteId, point: { latitude: cell.lat, longitude: cell.lng } } : undefined,
      wifi: wifi.map((s) => ({ id: s.siteId, point: { latitude: s.lat, longitude: s.lng } })) },
    thresholds: DEFAULT_THRESHOLDS,
  };
}

function rows(registry: { ids: string[]; run: () => RuleResult }[]) {
  return Object.fromEntries(registry.flatMap(({ ids, run }) => {
    const result = run();
    return ids.map((id) => [id, result.status === "triggered" && result.flag.id !== id ? "clear" : result.status]);
  }));
}

describe("all 21 families consume generated inputs with honest absence", () => {
  it("retains every fixed-manifest result and derives history statistics from actual events", () => {
    const reports = MANIFEST.map((seed) => {
      const config = configFor(seed);
      const history = buildSimulationHistory({ config, world, courier, parcels, startMs, idPrefix: "B-capabilities" });
      const timeline = buildSimulationTimeline({ config, world, courier, parcel: parcels[0], legs: NORMAL_LEGS, startMs, idPrefix: "B-capabilities" });
      const handoffs = history.warmup.map((built) => {
        const parcel = history.parcels.find((p) => p.epc === epcsOf(built.event)[0])!;
        const evaluated = runInconsistencyEngine(input(built, parcel));
        expect(evaluated.aborted).toBe(false);
        return { eventID: built.event.eventID, eventTime: built.event.eventTime, bizStep: built.event.bizStep,
          inconsistencyScore: evaluated.score, flagIds: evaluated.flags.map((f) => f.id),
          scanPoint: vigilSignalsOf(built.event)?.gps?.point, recipientPoint: parcel.recipientPoint,
          disputed: history.disputedEventIds.includes(built.event.eventID) };
      });
      // A documented independent fleet fixture, not a generated target score.
      const patternInput: PatternInput = { courierId: courier.courierId,
        window: { from: history.bootstrap.from!, to: timeline.timeline[0].event.eventTime }, handoffs,
        queueBaseline: { disputeRate: 0.02, sampleSize: 500 }, thresholds: DEFAULT_PATTERN_THRESHOLDS };
      const patternRows = rows(PATTERN_RULES.map((r) => ({ ids: r.ids, run: () => r.run(patternInput) })));
      expect(Object.keys(patternRows)).toEqual(["P1", "P2", "P3", "P4", "P5"]);
      const eventRows = timeline.timeline.map((built, i) => {
        const engineInput = input(built, parcels[0], timeline.timeline[i - 1]);
        const result = rows(INCONSISTENCY_RULES.map((r) => ({ ids: r.ids, run: () => r.run(engineInput) })));
        expect(Object.keys(result)).toHaveLength(16);
        expect(result.I1).toBe("not_evaluated");
        expect(result.I13).toBe("not_evaluated");
        return result;
      });
      return { seed, profile: history.bootstrap.profile, bootstrapCount: handoffs.length,
        disputes: history.disputedEventIds.length, eventRows, patternRows,
        hash: createHash("sha256").update(JSON.stringify({ timeline, history })).digest("hex") };
    });
    expect(reports).toHaveLength(24);
    expect(new Set(reports.map((r) => r.profile))).toEqual(new Set(["normal", "burst", "recurring-signals", "clumped-scans"]));
    for (const id of ["I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "I10", "I12", "I14", "I15", "I16"]) {
      expect(reports.some((report) => report.eventRows.some((row) => row[id] === "triggered")), id).toBe(true);
    }
    for (const id of ["P1", "P2", "P3", "P4", "P5"]) {
      expect(reports.some((report) => report.patternRows[id] === "triggered"), id).toBe(true);
    }
    // Golden reproduction records include every seed, each row state and bytes.
    expect(reports).toMatchSnapshot();
    const missingBaselineHistory = buildSimulationHistory({ config: configFor(MANIFEST[0]), world, courier, parcels: [], startMs, idPrefix: "B-empty" });
    const cold = runPatternEngine({ courierId: courier.courierId, window: { from: "2026-10-25T00:00:00+08:00", to: "2026-10-26T09:00:00+08:00" }, handoffs: [], thresholds: DEFAULT_PATTERN_THRESHOLDS });
    expect(missingBaselineHistory.warmup).toEqual([]);
    expect(cold.coverage.evaluated).toBe(0);
    expect(cold.coverage.notEvaluated.map((r) => r.id)).toEqual(["P1", "P2", "P3", "P4", "P5"]);
  });

  it("can evaluate registered radio contradictions without borrowing references online", () => {
    const sites = world.sitesByAddress[addressIndexFor(parcels[0])];
    const built = buildSimulationTimeline({ config: configFor("registered-evidence"), world, courier,
      parcel: parcels[0], legs: NORMAL_LEGS, startMs, idPrefix: "B-registered", registeredSites: sites,
      overrides: { delivery: { scanPoint: { latitude: 4.5, longitude: 101.7 }, gpsAccuracyMeters: 8 } } }).timeline.at(-1)!;
    expect(i1PositionConflict(input(built, parcels[0])).status).toBe("triggered");
    expect(i1PositionConflict({ ...input(built, parcels[0]), referenceSites: undefined }).status).toBe("not_evaluated");
  });

  it("uses existing mandate hours and never invents authorization", () => {
    const built = buildSimulationTimeline({ config: configFor("hours"), world, courier, parcel: parcels[0], legs: NORMAL_LEGS, startMs, idPrefix: "B-hours" }).timeline[0];
    const original = JSON.stringify(courier.mandate);
    const base = input(built, parcels[0]);
    expect(i13OutsideTimeWindow(base).status).toBe("not_evaluated");
    const mandate = { ...courier.mandate, validity: { ...courier.mandate.validity, timeWindows: [{ start: "00:00", end: "00:01" }] } };
    expect(i13OutsideTimeWindow({ ...base, mandate }).status).toBe("triggered");
    expect(JSON.stringify(courier.mandate)).toBe(original);
  });

  it("can retain a full recurring-signal batch while reporting thin clock-shifted windows honestly", () => {
    const histories = MANIFEST.map((seed) => {
      const config = configFor(seed);
      const history = buildSimulationHistory({ config, world, courier, parcels, startMs, idPrefix: "B-recency" });
      const current = buildSimulationTimeline({ config, world, courier, parcel: parcels[0], legs: NORMAL_LEGS, startMs, idPrefix: "B-recency" });
      return { history, deliveryMs: Date.parse(current.timeline.at(-1)!.event.eventTime) };
    });
    const recurring = histories.filter(({ history }) => history.bootstrap.profile === "recurring-signals");
    expect(recurring.length).toBeGreaterThan(0);
    const recentCounts = recurring.map(({ history, deliveryMs }) => {
      const recent = history.warmup.filter((b) => Date.parse(b.event.eventTime) > deliveryMs - 86_400_000);
      // Device configuration errors can move a claimed event across the real
      // rolling-window boundary. Never redraw clocks to force P3 coverage.
      const handoffs = recent.map((built) => {
        const parcel = history.parcels.find((p) => p.epc === epcsOf(built.event)[0])!;
        const result = runInconsistencyEngine(input(built, parcel));
        return { eventID: built.event.eventID, eventTime: built.event.eventTime,
          inconsistencyScore: result.score, flagIds: result.flags.map((flag) => flag.id) };
      });
      const outcome = runPatternEngine({ courierId: courier.courierId, handoffs,
        window: { from: new Date(deliveryMs - 86_400_000).toISOString(), to: new Date(deliveryMs).toISOString() },
        thresholds: DEFAULT_PATTERN_THRESHOLDS });
      expect(outcome.coverage.notEvaluated.some((row) => row.id === "P3")).toBe(recent.length < 20);
      return recent.length;
    });
    expect(recentCounts.some((count) => count >= 20)).toBe(true);
  });

  it("uses the same GPS claim for the two distance tiers, with an honest unavailable precise fix", () => {
    for (const [metres, expectedId] of [[500, "I11"], [5000, "I10"]] as const) {
      const built = buildSimulationTimeline({ config: configFor("distance-capability"), world, courier,
        parcel: parcels[0], legs: NORMAL_LEGS, startMs, idPrefix: "B-distance",
        overrides: { delivery: { scanPoint: offsetPoint(parcels[0].recipientPoint, metres, 0), gpsAccuracyMeters: 8 } } }).timeline.at(-1)!;
      const base = input(built, parcels[0]);
      const distanceRule = INCONSISTENCY_RULES.find((r) => r.ids.includes("I10"))!;
      const result = distanceRule.run(base);
      expect(result.status).toBe("triggered");
      if (result.status === "triggered") {
        expect(result.flag.id).toBe(expectedId);
        expect(result.flag.evidence.find((e) => e.field === "sensor.gps.point")?.value).toEqual(base.sensor?.gps?.point);
      }
      expect(distanceRule.run({ ...base, sensor: { ...base.sensor, gps: undefined } }).status).toBe("not_evaluated");
    }
  });
});

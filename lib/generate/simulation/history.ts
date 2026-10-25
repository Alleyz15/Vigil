import type { RandomSimulationConfig } from "@/lib/simulation/config";
import { distanceMeters } from "@/lib/engine/geo";
import { EpcisEvent } from "@/lib/epcis";
import { buildLegEvent, type BuiltEvent } from "../timeline";
import { isoAt, jitterPoint } from "../rng";
import type { GeneratedCourier, GeneratedParcel, GeneratedWorld } from "../world";
import { ASSUMPTIONS as A } from "./assumptions";
import { deviceClockSeconds } from "./signals";
import { simulationStream } from "./streams";
import type { HistoryProfile, SimulationCondition, SimulationBootstrapProvenance } from "./types";

/** Stateless bootstrap only. The caller owns the continuous courier journal. */
export function buildSimulationHistory(args: {
  config: RandomSimulationConfig; world: GeneratedWorld; courier: GeneratedCourier;
  parcels: GeneratedParcel[]; startMs: number; idPrefix: string;
}): {
  warmup: BuiltEvent[]; parcels: GeneratedParcel[]; disputedEventIds: string[];
  bootstrap: SimulationBootstrapProvenance; conditions: SimulationCondition[];
} {
  const { config, world, courier, startMs, idPrefix } = args;
  const stream = (name: string) => simulationStream(config, JSON.stringify(["history", courier.courierId, name]));
  const profile = stream("profile").pick<HistoryProfile>(["normal", "burst", "recurring-signals", "clumped-scans"]);
  const count = stream("count").int(...A.historyCount);
  // Keep distinct real parcel identities; an undersized world stays undersized.
  const unique = [...new Map(args.parcels.map((parcel) => [parcel.epc, parcel])).values()];
  const parcels = unique.slice(-count).map((parcel) => ({ ...parcel, recipientPoint: { ...parcel.recipientPoint } }));
  const conditions: SimulationCondition[] = [{ source: profile === "normal" ? "environment" : "behavior", code: `history-${profile}`, label: `Simulated bootstrap courier behavior: ${profile}` }];
  const building = parcels[0]?.recipientPoint;
  const buildingRound = profile === "burst" || profile === "recurring-signals";
  if (buildingRound && building) {
    // A building round has clustered addresses as well as clustered scans.
    for (const parcel of parcels) {
      parcel.recipientPoint = jitterPoint(stream(`${parcel.epc}:unit`), building, A.buildingRadiusMeters);
      parcel.recipientAddress = "Simulated units in one building";
    }
  }
  const intervals = parcels.map((parcel, i) => {
    if (i === 0) return 0;
    const rng = stream(`${parcel.epc}:interval`);
    return buildingRound ? rng.float(...A.historyBurstSeconds) :
      rng.float(...A.historyStopSeconds) + distanceMeters(parcels[i - 1].recipientPoint, parcel.recipientPoint) / (A.historyDrivingKmh / 3.6);
  });
  let trueMs = startMs - A.historyLeadMs - intervals.reduce((sum, interval) => sum + interval * 1000, 0);
  const roundStartMs = trueMs;
  let traveledKm = 0;
  let previousScan: GeneratedParcel["recipientPoint"] | undefined;
  const clock = deviceClockSeconds(config, courier.courierId, courier.deviceId);
  const disputedEventIds: string[] = [];
  const warmup = parcels.map((parcel, i) => {
    trueMs += intervals[i] * 1000;
    const rng = stream(`${parcel.epc}:event`);
    const scan = profile === "clumped-scans" && building
      ? jitterPoint(stream(`${parcel.epc}:van`), building, A.vanRadiusMeters) : parcel.recipientPoint;
    if (previousScan) traveledKm += distanceMeters(previousScan, scan) / 1000;
    previousScan = scan;
    const elapsedMinutes = (trueMs - roundStartMs) / 60_000;
    const built = buildLegEvent({
      world, courier, parcel, leg: { name: "delivery", where: "recipient", offsetMinutes: 0,
        bizStep: "urn:epcglobal:cbv:bizstep:delivering", disposition: "urn:epcglobal:cbv:disp:retail_sold" },
      legIndex: i, startMs: trueMs, rng, eventIdSeed: `${idPrefix}-bootstrap-${parcel.epc}`,
      overrides: {
        scanPoint: scan, omitCell: true, omitWifi: true,
        eventTime: isoAt(trueMs + clock * 1000), recordTime: isoAt(trueMs + rng.float(...A.uploadSeconds) * 1000),
        photoExifCaptureTime: isoAt(trueMs + clock * 1000 - rng.float(...A.photoSeconds) * 1000),
        mockLocation: profile === "recurring-signals",
        batteryPercent: Math.max(A.minimumBatteryPercent,
          A.initialBatteryPercent - elapsedMinutes * A.batteryPerMinute - traveledKm * A.batteryPerKm),
        batteryCharging: false,
      },
    });
    built.event = EpcisEvent.parse(built.raw);
    if (stream(`${parcel.epc}:dispute`).chance(profile === "normal" ? A.normalDisputeProbability : A.anomalousDisputeProbability)) {
      disputedEventIds.push(built.event.eventID);
    }
    return built;
  });
  return { warmup, parcels, disputedEventIds, conditions,
    bootstrap: { profile, bootstrapCount: warmup.length,
      ...(warmup.length ? { from: warmup[0].event.eventTime, to: warmup.at(-1)!.event.eventTime } : {}) } };
}

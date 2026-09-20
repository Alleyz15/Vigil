import { createHash } from "node:crypto";
import { makeRng } from "@/lib/generate/rng";
import { buildWarmup } from "@/lib/generate/scenarios/warmup";
import type { GeneratedScenario } from "@/lib/generate/scenarios/types";
import { buildTimeline, NORMAL_LEGS, type BuiltEvent, type LegName, type LegOverrides, type LegSpec } from "@/lib/generate/timeline";
import { travelMinutes } from "@/lib/generate/route";
import { epcFor, prefixFor, type GeneratedParcel, type GeneratedWorld } from "@/lib/generate/world";
import { distanceMeters } from "@/lib/engine/geo";
import { routeBetween, type DepotRoute, type Point } from "./depot";
import { addressLabelOf, type ShipmentHistory } from "./store";

/**
 * An online shipment, turned into the same `GeneratedScenario` every other
 * shipment is — so it goes through the same `ingestScenario`, the same
 * `runAgent`, the same gate. This file is an ADAPTER, not a second generator:
 * the timeline, the warm-up and every EPCIS event are built by `lib/generate`,
 * through the schema, exactly as a seeded scenario's are. What it sets
 * explicitly is only what the generator would otherwise have invented:
 *
 *   COORDINATES. The delivery reference on the parcel is the point a person
 *   confirmed, byte for byte. The generator puts a parcel's doorstep 60 m off
 *   its geocoded centroid, because a centroid is not a door; here the person
 *   has already chosen the door, and moving it by 60 m without saying so would
 *   be the interface lying about what was confirmed — the same class as quietly
 *   snapping a click to a nearby address. The simulated courier's scan position
 *   is a SEPARATE input, labelled as a simulation, and never feeds the reference.
 *
 *   EVENT IDS. Set per leg from the server-minted shipment id through sha256,
 *   not through `uuidFrom` (see store.ts for why).
 *
 *   NO CELL, NO WIFI. The reference-site registry covers the cached addresses
 *   only. An arbitrary point has no registered sites, so there is nothing true
 *   to put in the scan: inventing a tower ID would either be absent from the
 *   registry (and so mean nothing) or borrowed from another address (and so
 *   manufacture the very I1 contradiction rule 2c forbids). The scan carries
 *   none, the engine's assembly records the absence, and I1 reports
 *   `not_evaluated`. Every rule that does not read reference sites runs as usual.
 *
 * THE ANTI-CIRCULARITY GUARD COVERS THIS DIRECTORY. It builds world facts —
 * where the courier stood, how long the van took — and it must not read a
 * detector threshold to decide any of them. `lib/purity.test.ts` scans it with
 * `lib/generate`, so moving world-building here is not a way around the rule.
 */

/** The courier who carries online shipments: the builder's, so S0/S1's courier keeps its own history. */
const ONLINE_COURIER_INDEX = 1;
/** Same split the builder uses: authored parcels first, warm-up from the tail. */
const WARMUP_PARCEL_OFFSET = 45;

export type OnlineScenarioId = `B-O-${string}`;

export function scenarioIdFor(shipmentId: string): OnlineScenarioId {
  return `B-O-${shipmentId}`;
}

/** A name-based UUID (RFC 9562 version 8) from sha256. Unique because the shipment id is. */
export function eventIdFor(shipmentId: string, legSeed: string): string {
  const hex = createHash("sha256").update(`${shipmentId}:${legSeed}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Why location cross-checking has less to work with here, said at the level of
 * the LOCATION rather than the rule, so the operator's view can show it where
 * the point is drawn.
 *
 * WORDED TO THE MECHANISM. It is not "there are no towers nearby" — the engine
 * never searches for nearby towers. It looks up the IDs a device reported, and
 * an arbitrary point's IDs are not in the registry.
 */
export type LocationEvidenceGap = {
  code: "reference_sites_unregistered";
  summary: string;
  detail: string;
};

export const UNREGISTERED_LOCATION_GAP: LocationEvidenceGap = {
  code: "reference_sites_unregistered",
  summary: "No registered reference sites for this location",
  detail:
    "The site registry covers the cached addresses only. A handset at this point would report a " +
    "serving cell and access points whose IDs are not in the registry, so GPS cannot be compared " +
    "against an independently located source here. This simulated scan reports no cell or WiFi " +
    "rather than invented ones. Check the evaluable-check count on the verdict; it is read from " +
    "the engine's result for this handoff.",
};

export type OnlineBuild = {
  scenario: GeneratedScenario;
  route: DepotRoute;
  /** The legs, retimed for this route's distances. */
  legs: LegSpec[];
  locationGap: LocationEvidenceGap;
};

/**
 * Build the scenario for a stored shipment.
 *
 * `scan` is where the simulated courier stands for the delivery scan. Omitted,
 * the scan is taken at the CURRENT delivery reference — the point the courier
 * was sent to, corrected or not. Every leg before delivery is independent of
 * it: each leg draws from its own derived stream, so rebuilding with a
 * different scan changes the delivery leg and nothing earlier.
 */
export function buildOnlineScenario(
  history: ShipmentHistory,
  context: {
    world: GeneratedWorld;
    startMs: number;
    scan?: Point;
    /**
     * Extra facts about the delivery scan — a mock-location flag, a failed
     * attestation. Composed on top of the scan position, never replacing the
     * reference. Tests use it to show rules that read no reference site still
     * run at an arbitrary point.
     */
    deliveryOverrides?: LegOverrides;
  },
): OnlineBuild {
  const { world, startMs } = context;
  const { shipment } = history;
  const id = scenarioIdFor(shipment.shipmentId);
  const rng = makeRng(`online::${shipment.shipmentId}`);

  const courier = world.couriers[ONLINE_COURIER_INDEX];
  const courierParcels = world.parcels.filter((p) => p.epc.startsWith(prefixFor(ONLINE_COURIER_INDEX)));

  const reference = history.originalReference;
  const current = history.currentReference;
  const scan = context.scan ?? pointOf(current);
  const route = routeBetween(pointOf(history.origin), pointOf(reference));
  // The van drives to where the courier actually goes, which after a
  // correction is not the point on record.
  const lastMileMetres = distanceMeters(route.destinationDepot, scan);
  const legs = retime(route.lineHaulMetres, lastMileMetres);

  const parcel: GeneratedParcel = {
    epc: epcFor(ONLINE_COURIER_INDEX, serialFor(shipment.shipmentId)),
    waybillNo: `WB-ON-${shipment.shipmentId.slice(0, 8).toUpperCase()}`,
    recipientName: shipment.recipientName?.trim() || courierParcels[0].recipientName,
    recipientPhone: shipment.recipientChannel,
    recipientAddress: addressLabelOf(reference),
    // THE ORIGINAL REFERENCE, UNMOVED. A correction does not rewrite it: that
    // unreconciled gap is the stale record, as in session 20.
    recipientPoint: pointOf(reference),
    declaredValueSen: shipment.declaredValueSen,
    codAmountSen: shipment.codAmountSen,
  };

  const warmup = buildWarmup({
    world,
    courier,
    parcels: courierParcels.slice(WARMUP_PARCEL_OFFSET),
    rng: rng.derive("warmup"),
    startMs: startMs - 6 * 60 * 60 * 1000,
    idPrefix: id,
  });

  const overrides: Partial<Record<LegName, LegOverrides>> = {};
  for (const leg of legs) {
    overrides[leg.name] = {
      eventID: eventIdFor(shipment.shipmentId, leg.name) as LegOverrides["eventID"],
      ...(leg.where === "recipient"
        ? { scanPoint: { ...scan }, omitCell: true, omitWifi: true, ...context.deliveryOverrides }
        : {}),
    };
  }

  const timeline: BuiltEvent[] = buildTimeline({
    world,
    courier,
    parcel,
    startMs,
    rng: rng.derive("timeline"),
    idPrefix: id,
    legs,
    hubs: { origin: route.originDepot, destination: route.destinationDepot },
    overrides,
  });

  return {
    route,
    legs,
    locationGap: UNREGISTERED_LOCATION_GAP,
    scenario: {
      id,
      title: `Online shipment — ${addressLabelOf(history.origin)} to ${addressLabelOf(reference)}`,
      description: describe(route),
      courier,
      parcels: [parcel],
      warmup,
      timeline,
      disputedEventIds: [],
      expectation: { exceptionAtLeg: null, decision: "accept", axis: "none" },
    },
  };
}

function pointOf(p: { latitude: number; longitude: number }): Point {
  return { latitude: p.latitude, longitude: p.longitude };
}

/** A numeric EPC serial from the shipment id, clear of the world's small serials. */
function serialFor(shipmentId: string): number {
  return 1_000_000 + (parseInt(createHash("sha256").update(shipmentId).digest("hex").slice(0, 8), 16) % 1_000_000_000);
}

/**
 * NORMAL_LEGS with the two moving gaps retimed, the rest left alone.
 *
 * The same rule as `retime` in `lib/generate/route.ts`, which is private and
 * keyed to cached-address routes; it is restated rather than exported because
 * `lib/generate` is frozen for this phase. Both use the generator's own
 * `travelMinutes`, so the road-speed assumption stays in one place.
 */
function retime(lineHaulMetres: number, lastMileMetres: number): LegSpec[] {
  const out: LegSpec[] = [];
  let offset = 0;
  for (let i = 0; i < NORMAL_LEGS.length; i++) {
    const leg = NORMAL_LEGS[i];
    out.push({ ...leg, offsetMinutes: offset });
    const next = NORMAL_LEGS[i + 1];
    if (!next) break;
    offset +=
      leg.name === "linehaul_departure"
        ? travelMinutes(lineHaulMetres)
        : leg.name === "out_for_delivery"
          ? travelMinutes(lastMileMetres)
          : next.offsetMinutes - leg.offsetMinutes;
  }
  return out;
}

function describe(route: DepotRoute): string {
  const haul = route.local
    ? `A local delivery: both ends are served by ${route.originDepot.label}, so no line-haul between depots is invented.`
    : `${(route.lineHaulMetres / 1000).toFixed(1)} km of line-haul between ${route.originDepot.label} and ${route.destinationDepot.label}.`;
  return (
    `Created online from two points the sender confirmed on a map. ${haul} ` +
    `The delivery scan's position is simulated and labelled as such. Every leg runs through the same agent as a seeded scenario.`
  );
}

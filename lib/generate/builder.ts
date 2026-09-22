import { createHash } from "node:crypto";
import { EpcisEvent } from "@/lib/epcis/events";
import { isoAt, makeRng, type Rng } from "./rng";
import { buildWarmup } from "./scenarios/warmup";
import type { BuiltScenarioId, GeneratedScenario } from "./scenarios/types";
import { buildTimeline, type BuiltEvent, type LegOverrides } from "./timeline";
import { resolveRoute, type Route } from "./route";
import {
  epcFor,
  jitterPoint,
  prefixFor,
  type GeneratedParcel,
  type GeneratedWorld,
} from "./world";

/**
 * Shipments composed by a viewer rather than authored in advance.
 *
 * THIS IS A NEW WAY TO COMPOSE FAULTS, NOT NEW FAULT LOGIC. Every fault below
 * is expressed through the same `LegOverrides` and `replay` seams the seeded
 * scenarios use, and the result is an ordinary `GeneratedScenario` that goes
 * through the same `ingestScenario` and the same `runAgent`. There is no second
 * path — session 7 paid that lesson in full, and the copy that drifts is always
 * the one without the tests.
 *
 * WHAT THE BUILDER DOES NOT DO. It does not read a detector threshold, directly
 * or by implication. It builds a WORLD — where the depots are, how long the van
 * takes, what the sender declared — and the detectors compute statistics on it.
 * The anti-circularity guard in `lib/purity.test.ts` covers this file because it
 * recurses the whole tree, and it gets no exception for being a UI feature.
 */

export type BuiltFault =
  | "none"
  | "gps_spoof"
  | "clock_tamper"
  | "out_of_scope"
  | "eventid_reuse"
  | "batch_scan";

export type SenderDeclaration = {
  originIndex: number;
  destinationIndex: number;
  /**
   * What the sender says the parcel is worth.
   *
   * LOAD-BEARING, AND ALREADY SO. The courier's mandate carries
   * `requiresCosignIf: parcel_value_over_sen`, so a sender declaring above that
   * figure is what CAUSES the co-signature to be required — not a UI toggle,
   * not a demo flag. The whole chain from declaration to operator signature is
   * existing behaviour.
   */
  declaredValueSen: number;
  codAmountSen?: number;
  /**
   * The recipient's independently registered channel.
   *
   * I15 compares the channel the OTP verifier actually used against this. The
   * sender declares it; the recipient is verified against it. Two parties, or
   * the claim certifies itself.
   */
  recipientChannel: string;
  recipientName?: string;
};

export type BuildRequest = SenderDeclaration & {
  fault: BuiltFault;
  /** Same route + same fault + same seed produces identical bytes. */
  seed?: string;
};

export type BuildRefusal = {
  ok: false;
  /** Names what the fault needs, so the answer is actionable rather than merely true. */
  reason: string;
};

export type BuildSuccess = {
  ok: true;
  scenario: GeneratedScenario;
  route: Route;
  /** The id prefix every event on this run derives from. */
  runId: BuiltScenarioId;
};

export type BuildResult = BuildSuccess | BuildRefusal;

export const DEFAULT_BUILD_SEED = "vigil-2026";

/**
 * A stable id for this request.
 *
 * Derived from the request, so the same route with the same fault and seed
 * reproduces byte for byte — and, because `uuidFrom` keys event ids off this
 * string plus the leg name, two DIFFERENT requests cannot collide either.
 * `B-` keeps the whole namespace clear of the authored scenarios.
 */
export function runIdFor(request: BuildRequest): BuiltScenarioId {
  const seed = request.seed ?? DEFAULT_BUILD_SEED;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        request.originIndex,
        request.destinationIndex,
        request.declaredValueSen,
        request.codAmountSen ?? 0,
        request.recipientChannel,
        request.recipientName ?? "",
        request.fault,
        seed,
      ]),
    )
    .digest("hex");
  return `B-${digest.slice(0, 10)}`;
}

/** Which courier carries built shipments. Index 1, so S0/S1's courier keeps its own history. */
const BUILDER_COURIER_INDEX = 1;

/** Parcels [0,45) belong to authored scenarios; warm-up draws from the tail. Same split. */
const WARMUP_PARCEL_OFFSET = 45;

export function buildRequestedScenario(
  request: BuildRequest,
  context: {
    world: GeneratedWorld;
    startMs: number;
    /**
     * Extra overrides merged into the delivery leg.
     *
     * Used when the courier delivers somewhere other than the address on
     * record — a mid-route correction. Rebuilding the whole run with the same
     * request and seed keeps every earlier leg byte-identical and keeps the
     * delivery's event id the same, because `uuidFrom` derives it from the run
     * id and leg name: it is the SAME handoff, actually delivered.
     */
    deliveryOverride?: LegOverrides;
  },
): BuildResult {
  if (request.fault === "batch_scan") {
    // A degraded version of this is not a smaller version of it: one parcel
    // scanned from one spot is a delivery, not a batch. P4 compares clustered
    // SCANS against spread ADDRESSES, and with a single address there is no
    // spread to contradict. Naming what it needs beats a fault that silently
    // does nothing (rule 3g — a true message that is not actionable has not
    // done its job).
    return {
      ok: false,
      reason:
        "Batch scanning is a property of a set, not of one parcel: it needs dozens addressed to " +
        "one building, scanned from the lobby. A single shipment cannot express it. The seeded " +
        "S2 scenario carries forty parcels to one condo tower — open that instead.",
    };
  }

  const runId = runIdFor(request);
  const seed = request.seed ?? DEFAULT_BUILD_SEED;
  const rng = makeRng(`${seed}::${runId}`);

  const { world, startMs } = context;
  const courier = world.couriers[BUILDER_COURIER_INDEX];
  const courierParcels = world.parcels.filter((p) =>
    p.epc.startsWith(prefixFor(BUILDER_COURIER_INDEX)),
  );

  const route = resolveRoute({
    originIndex: request.originIndex,
    destinationIndex: request.destinationIndex,
  });

  const parcel = parcelFor(request, route, rng.derive("parcel"), courierParcels[0], runId);

  // Timed against the doorstep the courier is actually driving to, not the
  // address label's centroid.
  const routed = resolveRoute({
    originIndex: request.originIndex,
    destinationIndex: request.destinationIndex,
    recipientPoint: parcel.recipientPoint,
  });

  /**
   * Warm-up, so the pattern axis is EVALUATED rather than cold start.
   *
   * Without it every built shipment lands in cold start, every leg demands a
   * co-signature, and the orthogonal gate never gets to demonstrate itself —
   * row 2 of the matrix is unreachable. The count is `buildWarmup`'s own
   * default, deliberately: computing one from the cold-start floor would mean
   * the generator reading a pattern threshold, which is the circularity the
   * guard exists to prevent. The test asserts the axis came back evaluated, not
   * that any particular number of handoffs was used.
   */
  const warmup = buildWarmup({
    world,
    courier,
    parcels: courierParcels.slice(WARMUP_PARCEL_OFFSET),
    rng: rng.derive("warmup"),
    startMs: startMs - 6 * 60 * 60 * 1000,
    idPrefix: runId,
  });

  const deliveryLeg = routed.legs[routed.legs.length - 1];
  const deliveryMs = startMs + deliveryLeg.offsetMinutes * 60_000;

  const timeline = buildTimeline({
    world,
    courier,
    parcel,
    startMs,
    rng: rng.derive("timeline"),
    idPrefix: runId,
    legs: routed.legs,
    hubs: { origin: routed.originHub, destination: routed.destinationHub },
    overrides: mergeDelivery(
      overridesFor(request.fault, {
        parcel,
        rng: rng.derive("fault"),
        deliveryMs,
        world,
        route: routed,
      }),
      context.deliveryOverride,
    ),
  });

  return {
    ok: true,
    runId,
    route: routed,
    scenario: {
      id: runId,
      title: titleFor(request, routed),
      description: describe(request, routed),
      courier,
      parcels: [parcel],
      warmup,
      timeline,
      disputedEventIds: [],
      expectation: expectationFor(request.fault),
      ...(request.fault === "eventid_reuse" ? { replay: replayOf(timeline, courierParcels) } : {}),
    },
  };
}

/**
 * The parcel, which is almost entirely the sender's declarations.
 *
 * The EPC comes from the courier's own prefix so H2 and H3 pass on a clean run
 * — the mandate's scope is an EPC prefix, not geography, so "covering the
 * route" means exactly this and nothing about coordinates.
 */
function parcelFor(
  request: BuildRequest,
  route: Route,
  rng: Rng,
  template: GeneratedParcel,
  runId: BuiltScenarioId,
): GeneratedParcel {
  const identity = parseInt(createHash("sha256").update(runId).digest("hex").slice(0, 8), 16);
  return {
    // The serial changes per shipment while the courier-owned prefix remains
    // unchanged. H2 authorises the prefix; identity lives in the serial.
    epc: epcFor(BUILDER_COURIER_INDEX, 1_000_000 + (identity % 1_000_000_000)),
    waybillNo: `WB-BUILT-${runId.slice(2).toUpperCase()}`,
    recipientName: request.recipientName?.trim() || template.recipientName,
    recipientPhone: request.recipientChannel,
    recipientAddress: route.destination.label,
    // The doorstep is not the geocoded centroid, the same way buildWorld does it.
    recipientPoint: jitterPoint(rng, route.destination, 60),
    declaredValueSen: request.declaredValueSen,
    codAmountSen: request.codAmountSen ?? 0,
  };
}

function mergeDelivery(
  base: Partial<Record<string, LegOverrides>>,
  extra: LegOverrides | undefined,
): Partial<Record<string, LegOverrides>> {
  if (!extra) return base;
  return { ...base, delivery: { ...base.delivery, ...extra } };
}

function overridesFor(
  fault: BuiltFault,
  ctx: { parcel: GeneratedParcel; rng: Rng; deliveryMs: number; world: GeneratedWorld; route: Route },
): Partial<Record<string, LegOverrides>> {
  switch (fault) {
    case "gps_spoof": {
      // Claims the doorstep while the courier is elsewhere, and reports the
      // cell it can actually see — the contradiction I1 exists to find.
      const elsewhere = ctx.world.sitesByAddress[ctx.route.originHub.addressIndex];
      return {
        delivery: {
          scanPoint: jitterPoint(ctx.rng, ctx.parcel.recipientPoint, 20),
          mockLocation: true,
          cellSiteId: elsewhere.cell,
          wifiBssid: elsewhere.wifi,
        },
      };
    }

    case "clock_tamper":
      // The device claims the scan happened in the server's future. Upload
      // latency cannot produce this direction — rule 4e.
      return {
        delivery: {
          eventTime: isoAt(ctx.deliveryMs + 105 * 60_000),
          recordTime: isoAt(ctx.deliveryMs),
        },
      };

    case "out_of_scope":
      // A parcel from another courier's route entirely.
      return { delivery: { epc: epcFor(3, 7) } };

    case "eventid_reuse":
    case "none":
    case "batch_scan":
      return {};
  }
}

/** The second submission: same eventID, different parcel. Rule 7 — the attempt is evidence. */
function replayOf(timeline: BuiltEvent[], courierParcels: GeneratedParcel[]) {
  const delivery = timeline[timeline.length - 1];
  const forgedRaw = {
    ...(delivery.raw as Record<string, unknown>),
    epcList: [courierParcels[1].epc],
  };
  return {
    event: { ...delivery, event: EpcisEvent.parse(forgedRaw), raw: forgedRaw },
    expectAbort: "EVENT_ID_REUSE" as const,
  };
}

function expectationFor(fault: BuiltFault): GeneratedScenario["expectation"] {
  switch (fault) {
    case "gps_spoof":
      return { exceptionAtLeg: "delivery", decision: "flag", axis: "single_event" };
    case "clock_tamper":
      return { exceptionAtLeg: "delivery", decision: "flag", axis: "single_event" };
    case "out_of_scope":
      return { exceptionAtLeg: "delivery", decision: "freeze", axis: "single_event" };
    case "eventid_reuse":
      return { exceptionAtLeg: "delivery", decision: "accept", axis: "none" };
    case "none":
    case "batch_scan":
      return { exceptionAtLeg: null, decision: "accept", axis: "none" };
  }
}

const FAULT_TITLES: Record<BuiltFault, string> = {
  none: "Ordinary work",
  gps_spoof: "GPS spoofing at the delivery scan",
  clock_tamper: "Clock tampering at the delivery scan",
  out_of_scope: "A parcel outside the courier's mandate",
  eventid_reuse: "Event ID reuse",
  batch_scan: "Batch scanning",
};

function titleFor(request: BuildRequest, route: Route): string {
  return `${FAULT_TITLES[request.fault]} — ${route.origin.label} to ${route.destination.label}`;
}

function describe(request: BuildRequest, route: Route): string {
  const haul = route.local
    ? `A local shipment: both ends are served by ${route.originHub.label}, so the line-haul legs happen at one facility.`
    : `${(route.lineHaulMetres / 1000).toFixed(1)} km of line-haul between ${route.originHub.label} and ${route.destinationHub.label}.`;

  return (
    `Built from the sender's declarations rather than authored in advance. ` +
    `${haul} Declared value ${(request.declaredValueSen / 100).toFixed(2)} MYR. ` +
    `Every leg runs through the same agent as a seeded scenario.`
  );
}

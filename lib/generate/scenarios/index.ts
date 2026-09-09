import { EpcisEvent } from "@/lib/epcis";
import { CAREFULNESS, type Carefulness, forgedScanOverrides } from "../carefulness";
import { isoAt, jitterPoint, offsetPoint } from "../rng";
import { type BuiltEvent, buildLegEvent, buildTimeline, uuidFrom } from "../timeline";
import { planShipmentNoise } from "../noise";
import { ADDRESSES, addressIndexFor, epcFor, prefixFor } from "../world";
import type { GeneratedScenario, ScenarioBuilder, ScenarioContext, ScenarioId } from "./types";
import { buildWarmup } from "./warmup";

/**
 * S0-S6, per track idea.md section 8.
 *
 * Each is a full timeline with at most one thing wrong, at one leg. Three carry
 * the argument:
 *
 *   S0  ordinary work is accepted, and no operator is troubled
 *   S2  every single event is clean and the courier is still caught
 *   S6  looks like S2's opposite number and must NOT be escalated
 *
 * S2 and S6 are the pair the project rests on: similar surfaces, opposite
 * verdicts, for reasons no per-event system can see.
 */

/** Scenarios use parcels [0, 45); warm-up uses [45, ...). Disjoint on purpose. */
const WARMUP_PARCEL_OFFSET = 45;

/** Everything a scenario needs from the world, resolved once. */
function setup(ctx: ScenarioContext, courierIndex: number, id: string) {
  const courier = ctx.world.couriers[courierIndex];
  const parcels = ctx.world.parcels.filter((p) => p.epc.startsWith(prefixFor(courierIndex)));
  const rng = ctx.rng.derive(id);

  // Warm-up runs the day before, inside the 24h pattern window relative to the
  // scenario's own legs, so the courier is established rather than cold.
  // Warm-up draws from the TAIL of the courier's parcels, disjoint from the
  // head the scenarios use. S2 re-addresses its batch to a single tower, and a
  // parcel shared between warm-up and the batch would be delivered at its
  // original address during warm-up and re-addressed underneath it — firing
  // I10 on the warm-up handoffs for a fixture overlap rather than a fault.
  const warmup = buildWarmup({
    world: ctx.world,
    courier,
    parcels: parcels.slice(WARMUP_PARCEL_OFFSET),
    rng,
    startMs: ctx.startMs - 6 * 60 * 60 * 1000,
    idPrefix: id,
    noiseLevel: ctx.noiseLevel,
  });

  // The SAME derivation buildTimeline performs. `derive` is a pure function of
  // the parent's seed, not of its draw state, so this is the episode plan the
  // timeline actually got — not a second, independent draw.
  const noiseEpisodes = planShipmentNoise(rng, ctx.noiseLevel ?? 0)?.episodes;

  return { courier, parcels, rng, warmup, noiseEpisodes };
}

/* -------------------------------------------------------------------------- */
/* S0 — ordinary work                                                         */
/* -------------------------------------------------------------------------- */

const s0: ScenarioBuilder = (ctx) => {
  const { courier, parcels, rng, warmup, noiseEpisodes } = setup(ctx, 0, "S0");
  const parcel = parcels[0];

  return {
    id: "S0",
    title: "A normal delivery",
    description:
      "A parcel is collected, sorted, line-hauled overnight, taken out for delivery and handed " +
      "over. Nothing is wrong with it. This is the regression that protects the false-positive " +
      "claim: if a rule change makes ordinary work reach an operator's queue, this fails first.",
    courier,
    parcels: [parcel],
    warmup,
    timeline: buildTimeline({
      world: ctx.world,
      courier,
      parcel,
      startMs: ctx.startMs,
      rng,
      noiseLevel: ctx.noiseLevel,
      idPrefix: "S0",
    }),
    disputedEventIds: [],
    noiseEpisodes,
    expectation: {
      exceptionAtLeg: null,
      decision: "accept",
      forbidFlags: ["I1", "I2", "I3", "I4", "I5", "I7", "I10", "I11", "P1", "P2"],
      axis: "none",
    },
  };
};

/* -------------------------------------------------------------------------- */
/* S1 — GPS spoofing                                                          */
/* -------------------------------------------------------------------------- */

function buildS1(ctx: ScenarioContext, carefulness: Carefulness = 0): GeneratedScenario {
  const { courier, parcels, rng, warmup, noiseEpisodes } = setup(ctx, 1, `S1-${carefulness}`);
  const parcel = parcels[0];
  const profile = CAREFULNESS[carefulness];

  const addressIndex = addressIndexFor(parcel);
  const consistentSites = ctx.world.sitesByAddress[addressIndex];
  // The courier is actually somewhere else entirely — a different address, with
  // its own cell and its own access point.
  const elsewhereIndex = (addressIndex + 7) % ADDRESSES.length;
  const elsewhereSites = ctx.world.sitesByAddress[elsewhereIndex];

  return {
    id: "S1",
    title: `GPS spoofing at the delivery scan (carefulness ${carefulness})`,
    description:
      "The delivery scan reports the recipient's doorstep. The courier is elsewhere. What the " +
      "engine sees depends on how much of the surrounding evidence the attacker managed to " +
      `forge: ${profile.capability}`,
    courier,
    parcels: [parcel],
    warmup,
    timeline: buildTimeline({
      world: ctx.world,
      courier,
      parcel,
      startMs: ctx.startMs,
      rng,
      noiseLevel: ctx.noiseLevel,
      idPrefix: `S1-${carefulness}`,
      overrides: {
        delivery: forgedScanOverrides(
          profile,
          // Claims the doorstep.
          jitterPoint(rng.derive("claim"), parcel.recipientPoint, 20),
          consistentSites,
          elsewhereSites,
        ),
      },
    }),
    disputedEventIds: [],
    noiseEpisodes,
    expectation: {
      exceptionAtLeg: "delivery",
      // High axis 1, clean pattern: question the EVENT, do not accuse the courier.
      decision: "flag",
      expectFlags: carefulness === 0 ? ["I7"] : undefined,
      axis: "single_event",
    },
  };
}

const s1: ScenarioBuilder = (ctx) => buildS1(ctx, 0);

/* -------------------------------------------------------------------------- */
/* S2 — the signature case                                                    */
/* -------------------------------------------------------------------------- */

/**
 * S2: forty parcels for one condo tower, scanned from the lobby at twenty-second
 * intervals, and the customers complain.
 *
 * WHY NOT "BATCH SCANNING FROM THE VAN". The original framing has the courier
 * park and scan parcels addressed all over the neighbourhood. Traced against
 * the engine, that scenario is unbuildable as a signature case: scanning from
 * one spot puts every scan hundreds of metres to kilometres from its recipient
 * address, so I10/I11 fire on EVERY event and the events are not clean. Moving
 * the claimed positions to the addresses to fix that makes consecutive scans
 * imply impossible speeds, so I3 fires instead. Either way axis 1 catches it,
 * and S2 stops being the case that only the pattern axis can see.
 *
 * The condo tower keeps every event genuinely clean:
 *   - addresses are clustered, so P4 correctly stays silent (it is a building)
 *   - scans are AT the addresses, so I10/I11 are clean
 *   - the distances are metres, so I3 is clean
 *   - each event scores zero
 *
 * What is left is the shape. P1 sees a delivery rate no one can walk. P2 sees
 * the complaints. Neither exists inside any single event: P1 is a property of
 * the SET, and P2 is an outcome that arrives later.
 *
 * A fraudster can fake WHERE. They cannot fake HOW FAST, or WHETHER THE
 * CUSTOMER GOT IT. See CLAUDE.md.
 */
const s2: ScenarioBuilder = (ctx) => {
  // S2 composes its own legs rather than using buildTimeline, so the episode
  // plan does not apply to it and is deliberately not reported.
  const { courier, parcels, rng, warmup } = setup(ctx, 2, "S2");

  // One tower. Every parcel goes to the same building, different units.
  const towerIndex = 8;
  const tower = ADDRESSES[towerIndex];
  const sites = ctx.world.sitesByAddress[towerIndex];

  const batchSize = 40;
  const batch = parcels.slice(0, batchSize).map((parcel, i) => ({
    ...parcel,
    recipientAddress: tower.label,
    // Units in one building: metres apart, not kilometres.
    recipientPoint: offsetPoint(tower, (i % 8) * 4 - 16, Math.floor(i / 8) * 5 - 12),
  }));

  const deliveryLeg = {
    name: "delivery" as const,
    bizStep: "urn:epcglobal:cbv:bizstep:delivering",
    disposition: "urn:epcglobal:cbv:disp:retail_sold",
    offsetMinutes: 0,
    where: "recipient" as const,
  };

  // Twenty seconds per parcel. A courier who actually walked a tower would take
  // two to four minutes each; this is the behaviour, not a threshold.
  const timeline: BuiltEvent[] = batch.map((parcel, i) => {
    const legRng = rng.derive(`batch-${i}`);
    return buildLegEvent({
      world: ctx.world,
      courier,
      parcel,
      leg: deliveryLeg,
      legIndex: i,
      startMs: ctx.startMs + i * 20_000,
      rng: legRng,
      eventIdSeed: `S2-batch-${i}`,
      overrides: {
        // Scanned at each unit's door, as an honest round would be.
        scanPoint: jitterPoint(legRng, parcel.recipientPoint, 8),
        cellSiteId: sites.cell,
        wifiBssid: sites.wifi,
      },
    });
  });

  // The customers complain. Roughly a quarter of the batch, which is far above
  // any honest courier's rate.
  const disputedEventIds = timeline
    .filter((_, i) => i % 3 === 0)
    .map((built) => built.event.eventID);

  return {
    id: "S2",
    title: "Batch scanning a condo tower",
    description:
      "Forty parcels for one tower, all scanned from the lobby at twenty-second intervals. " +
      "Every event is individually clean: the scans are at the doors, the distances are metres, " +
      "the addresses really are clustered because it is one building. What is wrong is the " +
      "shape — a delivery rate no one can walk, and customers who say the parcel never came. " +
      "Neither is visible inside any single event.",
    courier,
    parcels: batch,
    warmup,
    timeline,
    disputedEventIds,
    expectation: {
      exceptionAtLeg: "delivery",
      decision: "escalate",
      expectFlags: ["P1", "P2"],
      // The whole claim: nothing on axis 1.
      forbidFlags: ["I1", "I2", "I3", "I7", "I10", "I11", "I12"],
      axis: "pattern",
    },
  };
};

/* -------------------------------------------------------------------------- */
/* S3 — eventID reuse                                                         */
/* -------------------------------------------------------------------------- */

/**
 * S3: the same eventID resubmitted carrying different content.
 *
 * NAMED FOR THE MECHANISM. Section 8 originally labelled this "EPC reuse", but
 * the behaviour it describes — and the check that catches it, H4 — is reuse of
 * the event identifier, not the parcel identifier. Named for what it is.
 */
const s3: ScenarioBuilder = (ctx) => {
  const { courier, parcels, rng, warmup, noiseEpisodes } = setup(ctx, 3, "S3");
  const parcel = parcels[0];

  const timeline = buildTimeline({
    world: ctx.world,
    courier,
    parcel,
    startMs: ctx.startMs,
    rng,
    idPrefix: "S3",
    noiseLevel: ctx.noiseLevel,
  });

  const delivery = timeline[timeline.length - 1];

  // The same eventID, a different parcel. A legitimate identifier, reused to
  // launder a second handoff through a receipt that was already issued.
  const forgedRaw = {
    ...delivery.raw,
    epcList: [parcels[1].epc],
  };

  return {
    id: "S3",
    title: "Event ID reuse",
    description:
      "The delivery scan is accepted. The same eventID is then submitted again carrying a " +
      "different parcel. The first submission is a receipt; the second tries to reuse it. The " +
      "ledger binds an eventID to the payload hash it was first seen with, so the second " +
      "submission aborts — and the attempt is written to the chain, because a failed forgery " +
      "is evidence.",
    courier,
    parcels: [parcel, parcels[1]],
    warmup,
    timeline,
    disputedEventIds: [],
    noiseEpisodes,
    expectation: {
      exceptionAtLeg: "delivery",
      decision: "accept",
      axis: "none",
    },
    replay: {
      event: { ...delivery, event: EpcisEvent.parse(forgedRaw), raw: forgedRaw },
      expectAbort: "EVENT_ID_REUSE",
    },
  };
};

/* -------------------------------------------------------------------------- */
/* S4 — out of scope                                                          */
/* -------------------------------------------------------------------------- */

const s4: ScenarioBuilder = (ctx) => {
  const { courier, parcels, rng, warmup, noiseEpisodes } = setup(ctx, 0, "S4");
  const parcel = parcels[1];

  // A parcel belonging to another courier's route entirely.
  const foreignEpc = epcFor(3, 7);

  return {
    id: "S4",
    title: "A scan outside the courier's route",
    description:
      "The courier scans a parcel that is not on their route. H2 refuses it: the mandate names " +
      "which EPC prefixes this courier may touch, and this is not one of them. An unscoped " +
      "actor is not an actor with unlimited scope.",
    courier,
    parcels: [parcel],
    warmup,
    timeline: buildTimeline({
      world: ctx.world,
      courier,
      parcel,
      startMs: ctx.startMs,
      rng,
      noiseLevel: ctx.noiseLevel,
      idPrefix: "S4",
      overrides: { delivery: { epc: foreignEpc } },
    }),
    disputedEventIds: [],
    noiseEpisodes,
    expectation: {
      exceptionAtLeg: "delivery",
      decision: "freeze",
      expectFlags: ["H2"],
      axis: "single_event",
    },
  };
};

/* -------------------------------------------------------------------------- */
/* S5 — clock tampering                                                       */
/* -------------------------------------------------------------------------- */

const s5: ScenarioBuilder = (ctx) => {
  const { courier, parcels, rng, warmup, noiseEpisodes } = setup(ctx, 1, "S5");
  const parcel = parcels[2];

  const deliveryMs = ctx.startMs + 1185 * 60_000;

  return {
    id: "S5",
    title: "Clock tampering at the delivery scan",
    description:
      "The device claims the delivery happened at 18:20. The server received it at 16:35. The " +
      "gap cannot be drift or upload latency — the device clock was set. The divergence between " +
      "the two timestamps costs nothing to check and is one of the few signals a device cannot " +
      "author both halves of.",
    courier,
    parcels: [parcel],
    warmup,
    timeline: buildTimeline({
      world: ctx.world,
      courier,
      parcel,
      startMs: ctx.startMs,
      rng,
      noiseLevel: ctx.noiseLevel,
      idPrefix: "S5",
      overrides: {
        delivery: {
          // The device claims an hour and three quarters later than the server saw it.
          eventTime: isoAt(deliveryMs + 105 * 60_000),
          recordTime: isoAt(deliveryMs),
        },
      },
    }),
    disputedEventIds: [],
    noiseEpisodes,
    expectation: {
      exceptionAtLeg: "delivery",
      decision: "flag",
      expectFlags: ["I4"],
      axis: "single_event",
    },
  };
};

/* -------------------------------------------------------------------------- */
/* S6 — the false-positive control                                            */
/* -------------------------------------------------------------------------- */

/**
 * S6: the same surface as S1, and it must NOT be escalated.
 *
 * A courier delivering to a basement carpark loses GNSS. The fix degrades to a
 * hundred-metre-plus uncertainty and drifts off the building; the cell drops.
 * On a dashboard this looks exactly like a location that does not match the
 * address — which is what S1 looks like too.
 *
 * The difference is that a degraded fix REPORTS its degradation, and a missing
 * cell observation is missing rather than contradictory. The location rules
 * report not_evaluated, the coverage line drops, and the courier's pattern is
 * clean. The system says so instead of guessing.
 */
const s6: ScenarioBuilder = (ctx) => {
  const { courier, parcels, rng, warmup, noiseEpisodes } = setup(ctx, 2, "S6");
  const parcel = parcels[41];

  return {
    id: "S6",
    title: "GPS degradation in a basement carpark",
    description:
      "The delivery is made in an underground carpark. The GNSS fix degrades to 140 metres of " +
      "uncertainty and drifts off the building; the serving cell is lost. This looks like S1 on " +
      "any dashboard. It is not: a degraded fix reports its own uncertainty and a missing cell " +
      "is missing rather than contradictory, so the location rules report not_evaluated instead " +
      "of clean. The courier's pattern is ordinary. The system declines to escalate, and says " +
      "how much evidence it actually had.",
    courier,
    parcels: [parcel],
    warmup,
    timeline: buildTimeline({
      world: ctx.world,
      courier,
      parcel,
      startMs: ctx.startMs,
      rng,
      noiseLevel: ctx.noiseLevel,
      idPrefix: "S6",
      overrides: {
        delivery: {
          // Drifted, and honest about how badly.
          scanPoint: offsetPoint(parcel.recipientPoint, 260, 190),
          gpsAccuracyMeters: 140,
          omitCell: true,
          omitWifi: true,
        },
      },
    }),
    disputedEventIds: [],
    noiseEpisodes,
    expectation: {
      exceptionAtLeg: null,
      decision: "accept",
      // The point of the scenario: nothing fires, on either axis.
      forbidFlags: ["I1", "I7", "I10", "I11", "P1", "P2", "P3", "P4", "P5"],
      axis: "none",
    },
  };
};

export const SCENARIOS: Record<ScenarioId, ScenarioBuilder> = {
  S0: s0,
  S1: s1,
  S2: s2,
  S3: s3,
  S4: s4,
  S5: s5,
  S6: s6,
};

export const SCENARIO_IDS = Object.keys(SCENARIOS) as ScenarioId[];

/** Build one scenario. */
export function buildScenario(id: ScenarioId, ctx: ScenarioContext): GeneratedScenario {
  return SCENARIOS[id](ctx);
}

/** S1 at a chosen carefulness, for the attacker-cost sweep. */
export function buildS1AtCarefulness(
  ctx: ScenarioContext,
  carefulness: Carefulness,
): GeneratedScenario {
  return buildS1(ctx, carefulness);
}

export { uuidFrom };
export type { GeneratedScenario, ScenarioContext, ScenarioExpectation, ScenarioId } from "./types";

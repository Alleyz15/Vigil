import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMigratedDb } from "@/lib/db/migrate";
import { couriers, disputes, events, mandates, parcels, referenceSites } from "@/lib/db/schema";
import { NonceLedger } from "@/lib/ledger";
import { mandateToRow } from "@/lib/assemble";
import { courierCredential, cosign, generateKeyPair } from "@/lib/credential";
import { runAgent } from "@/lib/agent/machine";
import { epcsOf } from "@/lib/epcis";
import type { AgentContext } from "@/lib/agent/context";
import type { NodeDeps } from "@/lib/agent/nodes";
import type { BuiltEvent } from "./timeline";
import type { GeneratedScenario } from "./scenarios/types";
import { type GeneratedWorld, prefixFor } from "./world";
import { uuidFrom } from "./timeline";

/**
 * Run a generated scenario through the real agent.
 *
 * WHERE THE I/O IS. The generator itself is a pure function of its seed; this
 * module is what puts the result into a database and a ledger and runs it. Kept
 * separate so a test can generate without ingesting, and so the generator never
 * acquires a dependency on the machine it is generating for.
 */

export type IngestHarness = {
  deps: NodeDeps;
  dir: string;
  /** The operator keypair this harness co-signs with. */
  operator: { publicKey: string; privateKey: string };
};

/** Stand up a database and ledger, seeded with the world's static rows. */
export function createHarness(world: GeneratedWorld): IngestHarness {
  const dir = mkdtempSync(join(tmpdir(), "vigil-generate-"));
  const db = createMigratedDb(":memory:");
  const operator = generateKeyPair();

  for (const courier of world.couriers) {
    db.insert(couriers)
      .values({
        courierId: courier.courierId,
        displayName: courier.displayName,
        publicKey: courier.keys.publicKey,
        boundDeviceId: courier.deviceId,
      })
      .run();
    db.insert(mandates).values(mandateToRow(courier.mandate)).run();
  }

  for (const parcel of world.parcels) {
    db.insert(parcels)
      .values({
        epc: parcel.epc,
        waybillNo: parcel.waybillNo,
        recipientName: parcel.recipientName,
        recipientAddress: parcel.recipientAddress,
        recipientLat: parcel.recipientPoint.latitude,
        recipientLng: parcel.recipientPoint.longitude,
        declaredValueSen: parcel.declaredValueSen,
        codAmountSen: parcel.codAmountSen,
      })
      .run();
  }

  if (world.referenceSites.length > 0) {
    db.insert(referenceSites)
      .values(
        world.referenceSites.map((site) => ({
          siteId: site.siteId,
          kind: site.kind,
          lat: site.lat,
          lng: site.lng,
          label: site.label,
        })),
      )
      .run();
  }

  return {
    dir,
    operator,
    deps: {
      db,
      ledger: new NonceLedger(join(dir, "nonce-ledger.jsonl")),
      // The server clock tracks the event being ingested, so replaying a
      // generated day does not manufacture an I4 for every event.
      now: () => new Date(),
      operatorPublicKey: operator.publicKey,
    },
  };
}

/**
 * Run one event, presenting a credential.
 *
 * Co-signs only when asked. The two-pass form below uses that: submit with the
 * courier's signature alone, and if the gate demands a co-signature, obtain one
 * and resubmit — which is what an operator console actually does.
 */
export function ingestEvent(
  harness: IngestHarness,
  built: BuiltEvent,
  args: { courierPrivateKey: string; mandateId: string; withCosign?: boolean },
): AgentContext {
  const event = built.event;
  const subject = {
    v: 1 as const,
    eventID: event.eventID,
    epc: epcsOf(event)[0] ?? "",
    courierId: event["vigil:courierId"] ?? "",
    mandateId: args.mandateId,
    nonce: `nonce-${event.eventID}`,
  };

  let credential = courierCredential(subject, args.courierPrivateKey);
  if (args.withCosign) {
    credential = cosign(credential, "OP-01", harness.operator.privateKey);
  }

  // The server clock follows the event, as it would if this were live.
  const stamped: NodeDeps = {
    ...harness.deps,
    now: () => new Date(Date.parse(event.recordTime ?? event.eventTime)),
  };

  return runAgent(event, stamped, { credential });
}

/**
 * Submit, and co-sign if the gate asks for one.
 *
 * This is the two-phase flow as a console would drive it: the courier's
 * signature goes up first, and only a handoff the gate marks as needing a
 * co-signature gets one. A handoff that seals on the first pass never troubled
 * an operator, which is the thing S0 is meant to demonstrate.
 */
export function ingestWithApproval(
  harness: IngestHarness,
  built: BuiltEvent,
  args: { courierPrivateKey: string; mandateId: string },
): { ctx: AgentContext; neededCosign: boolean } {
  const first = ingestEvent(harness, built, { ...args, withCosign: false });

  if (first.halted?.reason !== "PENDING_COSIGNATURE") {
    return { ctx: first, neededCosign: false };
  }

  const approved = ingestEvent(harness, built, { ...args, withCosign: true });
  return { ctx: approved, neededCosign: true };
}

export type IngestedScenario = {
  scenario: GeneratedScenario;
  harness: IngestHarness;
  /** One context per warm-up handoff, in order. */
  warmup: AgentContext[];
  /** One context per timeline leg, in order. */
  legs: AgentContext[];
  /** Which legs required an operator co-signature. */
  cosigned: boolean[];
  /** The replay attempt, for S3. */
  replay?: AgentContext;
};

/** Run a whole scenario: warm-up, then the timeline, then any replay. */
export function ingestScenario(
  scenario: GeneratedScenario,
  harness: IngestHarness,
): IngestedScenario {
  const args = {
    courierPrivateKey: scenario.courier.keys.privateKey,
    mandateId: scenario.courier.mandate.mandateId,
  };

  // The scenario's own parcels are authoritative. S2 re-addresses its batch to
  // a single tower, and the engine compares each scan against the recipient
  // coordinates ON FILE - so without this the tower scans are measured against
  // the world's original scattered addresses and I10 fires on every one.
  upsertParcels(harness, scenario);

  const warmup = scenario.warmup.map(
    (built) => ingestWithApproval(harness, built, args).ctx,
  );

  const legs: AgentContext[] = [];
  const cosigned: boolean[] = [];
  const disputed = new Set(scenario.disputedEventIds);

  for (const built of scenario.timeline) {
    const { ctx, neededCosign } = ingestWithApproval(harness, built, args);
    legs.push(ctx);
    cosigned.push(neededCosign);

    // A complaint about an earlier parcel arrives while the round is still
    // running, which is how it happens: the customer gets home, finds nothing,
    // and calls. Later handoffs are judged with it already on file.
    if (disputed.has(built.event.eventID)) {
      recordDispute(harness, built.event.eventID, epcsOf(built.event)[0] ?? "");
    }
  }

  const replay = scenario.replay
    ? ingestEvent(harness, scenario.replay.event, { ...args, withCosign: true })
    : undefined;

  return { scenario, harness, warmup, legs, cosigned, replay };
}

/**
 * The rest of the fleet's ordinary day.
 *
 * P2 asks whether a courier's dispute rate is out of line WITH THEIR PEERS, and
 * a baseline computed from one courier is that courier — the comparison is
 * vacuous, and a fraudster who is a quarter of the sample cannot be an outlier
 * against a sample that includes them.
 *
 * These rows are BACKGROUND CONTEXT, not events under test, so they are written
 * directly rather than run through the agent: the baseline query reads events
 * and disputes, never verdicts, and running two hundred handoffs through the
 * full pipeline to populate a denominator would only make the test slower. The
 * scenario's own events always go through the real agent.
 */
export function seedFleetBackground(
  harness: IngestHarness,
  world: GeneratedWorld,
  args: { excludeCourierId: string; deliveriesPerCourier?: number; startMs: number },
): void {
  const { excludeCourierId, deliveriesPerCourier = 60, startMs } = args;

  for (const courier of world.couriers) {
    if (courier.courierId === excludeCourierId) continue;

    const theirParcels = world.parcels.filter((p) =>
      p.epc.startsWith(prefixFor(world.couriers.indexOf(courier))),
    );

    for (let i = 0; i < Math.min(deliveriesPerCourier, theirParcels.length); i++) {
      const parcel = theirParcels[i];
      const at = new Date(startMs + i * 11 * 60_000).toISOString();
      const eventId = uuidFrom(`fleet-${courier.courierId}-${i}`);

      harness.deps.db
        .insert(events)
        .values({
          eventId,
          type: "ObjectEvent",
          eventTime: at,
          recordTime: at,
          eventTimeZoneOffset: "+08:00",
          bizStep: "urn:epcglobal:cbv:bizstep:delivering",
          disposition: "urn:epcglobal:cbv:disp:retail_sold",
          courierId: courier.courierId,
          primaryEpc: parcel.epc,
          payloadJson: "{}",
          payloadHash: "0".repeat(64),
        })
        .onConflictDoNothing()
        .run();
    }
  }
}

/**
 * "Delivered, but I never got it."
 *
 * The one input that is an OUTCOME rather than a sensor reading, and the reason
 * P2 sees something no single event contains: whatever the evidence said at the
 * time, the recipient disagrees, and they say so afterwards.
 */
export function recordDispute(harness: IngestHarness, eventId: string, epc: string): void {
  harness.deps.db
    .insert(disputes)
    .values({
      disputeId: `dsp-${eventId}`,
      eventId,
      epc,
      raisedAt: new Date().toISOString(),
      kind: "not_received",
    })
    .onConflictDoNothing()
    .run();
}

/** Write the scenario's parcels, overriding whatever the world seeded. */
function upsertParcels(harness: IngestHarness, scenario: GeneratedScenario): void {
  for (const parcel of scenario.parcels) {
    harness.deps.db
      .insert(parcels)
      .values({
        epc: parcel.epc,
        waybillNo: parcel.waybillNo,
        recipientName: parcel.recipientName,
        recipientAddress: parcel.recipientAddress,
        recipientLat: parcel.recipientPoint.latitude,
        recipientLng: parcel.recipientPoint.longitude,
        declaredValueSen: parcel.declaredValueSen,
        codAmountSen: parcel.codAmountSen,
      })
      .onConflictDoUpdate({
        target: parcels.epc,
        set: {
          recipientAddress: parcel.recipientAddress,
          recipientLat: parcel.recipientPoint.latitude,
          recipientLng: parcel.recipientPoint.longitude,
        },
      })
      .run();
  }
}

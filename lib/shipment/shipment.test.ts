import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, type VigilDb } from "@/lib/db/client";
import { createMigratedDb } from "@/lib/db/migrate";
import { locationCorrections, locationSnapshots, shipments } from "@/lib/db/schema";
import { buildWorld } from "@/lib/generate/world";
import { DEPOTS } from "@/lib/generate/route";
import { createHarness, ingestScenario, type IngestHarness } from "@/lib/generate/ingest";
import { distanceMeters } from "@/lib/engine/geo";
import { scriptedProvider } from "@/lib/llm";
import type { NodeDeps } from "@/lib/agent/nodes";
import { boundaryLabel, checkPoint, type ServiceBoundary } from "./boundary";
import { loadServiceBoundary, placeholderBoundary } from "./service-area";
import { ADDRESSES } from "@/lib/generate/world";
import { depotFor, routeBetween } from "./depot";
import { buildOnlineScenario, eventIdFor, UNREGISTERED_LOCATION_GAP } from "./build";
import {
  appendCorrection,
  createShipment,
  getShipment,
  type ShipmentRequest,
} from "./store";

/**
 * Online shipments at points a person confirmed on a map.
 *
 * The boundary below is a TEST FIXTURE: a rectangle chosen to contain the test
 * points. It is not Kuala Lumpur and is never loaded outside this file. The
 * product uses the labelled depot-radius placeholder until a sourced boundary is
 * confirmed; see "the placeholder boundary" below.
 */
const FIXTURE_BOUNDARY: ServiceBoundary = {
  version: "test-fixture-rectangle-v1",
  source: "test fixture",
  licence: "n/a",
  area: {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [101.6, 3.1],
          [101.76, 3.1],
          [101.76, 3.2],
          [101.6, 3.2],
          [101.6, 3.1],
        ],
      ],
    },
  },
};

// Arbitrary points, none of them a cached address.
const NEAR_BANGSAR_A = { latitude: 3.13, longitude: 101.67, addressClaim: "12 Jalan Contoh, Bangsar" };
const NEAR_BANGSAR_B = { latitude: 3.125, longitude: 101.685, addressClaim: "Unit 3-2, Jalan Ujian, Bangsar" };
const NEAR_AMPANG = { latitude: 3.165, longitude: 101.73, addressClaim: "Lot 8, Jalan Percubaan, Ampang" };
const OUTSIDE = { latitude: 3.3, longitude: 101.7, addressClaim: "Somewhere north" };

const REQUEST: ShipmentRequest = {
  origin: NEAR_BANGSAR_A,
  destination: NEAR_AMPANG,
  declaredValueSen: 12_000,
  recipientChannel: "+60111234567",
};

const WORLD = buildWorld("vigil-2026");
const START_MS = Date.parse("2026-09-08T00:00:00+08:00");
const NOW = "2026-09-08T09:00:00+08:00";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function freshDb(): VigilDb {
  const db = createMigratedDb(":memory:");
  cleanups.push(() => closeDb(db));
  return db;
}

function create(db: VigilDb, key: string, request: ShipmentRequest = REQUEST) {
  return createShipment(db, { request, idempotencyKey: key, boundary: FIXTURE_BOUNDARY, nowIso: NOW });
}

function created(db: VigilDb, key: string, request: ShipmentRequest = REQUEST) {
  const result = create(db, key, request);
  if (result.status !== "created") throw new Error(`expected created, got ${result.status}`);
  return getShipment(db, result.shipment.shipmentId)!;
}

async function ingest(scenario: Parameters<typeof ingestScenario>[0], llm?: NodeDeps["llm"]) {
  const harness: IngestHarness = createHarness(WORLD);
  harness.deps.llm = llm;
  cleanups.push(() => {
    closeDb(harness.deps.db);
    rmSync(harness.dir, { recursive: true, force: true });
  });
  return ingestScenario(scenario, harness);
}

describe("depots for an arbitrary point", () => {
  /** The three facilities are the existing ones, unmoved. A drift here would re-route every built shipment too. */
  it("keeps the existing three depots, 11.823 / 19.284 / 7.461 km apart", () => {
    expect(DEPOTS).toHaveLength(3);
    const km = (a: number, b: number) => Math.round(distanceMeters(DEPOTS[a], DEPOTS[b])) / 1000;
    expect([km(0, 1), km(0, 2), km(1, 2)]).toEqual([11.823, 19.284, 7.461]);
  });

  it("assigns the nearest depot by great-circle distance", () => {
    expect(depotFor(NEAR_BANGSAR_A).label).toMatch(/^Bangsar/);
    expect(depotFor(NEAR_AMPANG).label).toMatch(/^Jalan Ampang/);
  });

  it("breaks an exact tie by the depots' fixed order, not by iteration luck", () => {
    // Two facilities at one coordinate are an exact tie for every point.
    const first = { ...DEPOTS[1], label: "first" };
    const second = { ...DEPOTS[1], label: "second" };
    expect(depotFor(NEAR_AMPANG, [first, second]).label).toBe("first");
    expect(depotFor(NEAR_AMPANG, [second, first]).label).toBe("second");
  });

  it("calls two points served by one depot a local delivery and invents no line-haul", () => {
    const route = routeBetween(NEAR_BANGSAR_A, NEAR_BANGSAR_B);
    expect(route.local).toBe(true);
    expect(route.lineHaulMetres).toBe(0);
    expect(route.originDepot).toBe(route.destinationDepot);
  });

  it("routes between two depots when the ends are served by different ones", () => {
    const route = routeBetween(NEAR_BANGSAR_A, NEAR_AMPANG);
    expect(route.local).toBe(false);
    expect(Math.round(route.lineHaulMetres)).toBe(7461);
  });
});

describe("the boundary", () => {
  it("refuses every point when handed no boundary at all, rather than passing them through", () => {
    expect(checkPoint(NEAR_BANGSAR_A, null)).toMatchObject({ ok: false, code: "no_boundary" });
  });

  it("rejects a coordinate outside the boundary and writes nothing", () => {
    const db = freshDb();
    const result = create(db, "k-out", { ...REQUEST, destination: OUTSIDE });
    expect(result).toMatchObject({ status: "rejected", field: "destination", code: "outside" });
    expect(db.select().from(shipments).all()).toHaveLength(0);
    expect(db.select().from(locationSnapshots).all()).toHaveLength(0);
  });

  it("rejects a coordinate that is not a coordinate", () => {
    const db = freshDb();
    const result = create(db, "k-nan", { ...REQUEST, origin: { ...NEAR_BANGSAR_A, latitude: Number.NaN } });
    expect(result).toMatchObject({ status: "rejected", field: "origin", code: "invalid_coordinate" });
  });

  it("stamps the boundary version onto every snapshot it checked", () => {
    const db = freshDb();
    const history = created(db, "k-version");
    expect(history.origin.boundaryVersion).toBe("test-fixture-rectangle-v1");
    expect(history.originalReference.boundaryVersion).toBe("test-fixture-rectangle-v1");
  });
});

describe("creating a shipment: three outcomes, never two", () => {
  it("returns the SAME shipment for a retried request", () => {
    const db = freshDb();
    const first = create(db, "k-retry");
    const second = create(db, "k-retry");
    expect(first.status).toBe("created");
    expect(second.status).toBe("replayed");
    if (first.status !== "created" || second.status !== "replayed") return;
    expect(second.shipment.shipmentId).toBe(first.shipment.shipmentId);
    expect(db.select().from(shipments).all()).toHaveLength(1);
    // The losing attempt's two snapshots rolled back with it.
    expect(db.select().from(locationSnapshots).all()).toHaveLength(2);
  });

  it("refuses the same key with different content, and creates nothing", () => {
    const db = freshDb();
    create(db, "k-reuse");
    const result = create(db, "k-reuse", { ...REQUEST, declaredValueSen: 99_000 });
    expect(result.status).toBe("conflict");
    expect(db.select().from(shipments).all()).toHaveLength(1);
    expect(db.select().from(locationSnapshots).all()).toHaveLength(2);
  });

  it("creates a separate shipment for a new key, even to an identical address", () => {
    const db = freshDb();
    const a = created(db, "k-a");
    const b = created(db, "k-b");
    expect(a.shipment.shipmentId).not.toBe(b.shipment.shipmentId);
    expect(db.select().from(shipments).all()).toHaveLength(2);
  });

  it("treats an omitted default and the explicit default as one request", () => {
    const db = freshDb();
    create(db, "k-default");
    expect(create(db, "k-default", { ...REQUEST, codAmountSen: 0 }).status).toBe("replayed");
  });

  /**
   * Two connections to one file, as two server processes would have. The insert
   * is attempted before anything is read, so a writer that loses the race and a
   * writer that arrives after the winner take the same path — this interleaving
   * exercises it without needing threads.
   */
  it("keeps one shipment per key across two connections writing to one database", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigil-shipment-"));
    const path = join(dir, "shipments.db");
    const a = createMigratedDb(path);
    const b = createMigratedDb(path);
    cleanups.push(() => {
      closeDb(a);
      closeDb(b);
      rmSync(dir, { recursive: true, force: true });
    });

    const outcomes = [create(a, "k-race"), create(b, "k-race"), create(a, "k-race"), create(b, "k-race")];
    expect(outcomes.map((o) => o.status)).toEqual(["created", "replayed", "replayed", "replayed"]);
    const ids = new Set(outcomes.map((o) => ("shipment" in o ? o.shipment.shipmentId : null)));
    expect(ids.size).toBe(1);
    expect(create(b, "k-race", { ...REQUEST, recipientChannel: "+60119999999" }).status).toBe("conflict");
    expect(a.select().from(shipments).all()).toHaveLength(1);
  });

  it("is backed by the database, not only by the code path: a duplicate key insert fails", () => {
    const db = freshDb();
    const history = created(db, "k-db");
    // Real snapshots, so the only constraint left to violate is the key's.
    for (const snapshotId of ["s-origin", "s-reference"]) {
      db.insert(locationSnapshots).values({ ...history.origin, snapshotId, shipmentId: "another-id" }).run();
    }
    expect(() =>
      db
        .insert(shipments)
        .values({
          ...history.shipment,
          shipmentId: "another-id",
          originSnapshotId: "s-origin",
          referenceSnapshotId: "s-reference",
        })
        .run(),
    ).toThrow(/UNIQUE constraint failed: shipments\.idempotency_key/);
  });
});

describe("corrections append; the original reference is never overwritten", () => {
  it("keeps the original reference and records each move from the point before", () => {
    const db = freshDb();
    const history = created(db, "k-correct");
    const original = history.originalReference;

    const first = appendCorrection(db, {
      shipmentId: history.shipment.shipmentId,
      to: NEAR_BANGSAR_B,
      boundary: FIXTURE_BOUNDARY,
      nowIso: "2026-09-08T10:00:00+08:00",
    });
    const second = appendCorrection(db, {
      shipmentId: history.shipment.shipmentId,
      to: { ...NEAR_BANGSAR_B, latitude: 3.126, addressClaim: "Unit 3-2A, Jalan Ujian" },
      boundary: FIXTURE_BOUNDARY,
      nowIso: "2026-09-08T11:00:00+08:00",
    });
    expect(first.ok && second.ok).toBe(true);

    const after = getShipment(db, history.shipment.shipmentId)!;
    expect(after.originalReference).toEqual(original);
    expect(after.shipment.referenceSnapshotId).toBe(original.snapshotId);
    expect(after.corrections.map((c) => c.sequence)).toEqual([1, 2]);
    expect(after.corrections[0].fromSnapshotId).toBe(original.snapshotId);
    expect(after.corrections[1].fromSnapshotId).toBe(after.corrections[0].toSnapshotId);
    expect(after.currentReference.addressClaim).toBe("Unit 3-2A, Jalan Ujian");
  });

  it("rejects a correction outside the boundary and appends nothing", () => {
    const db = freshDb();
    const history = created(db, "k-correct-out");
    const result = appendCorrection(db, {
      shipmentId: history.shipment.shipmentId,
      to: OUTSIDE,
      boundary: FIXTURE_BOUNDARY,
      nowIso: NOW,
    });
    expect(result).toMatchObject({ ok: false, code: "outside" });
    expect(db.select().from(locationCorrections).all()).toHaveLength(0);
  });

  /** A property of the database file, not of this module: an UPDATE or DELETE aborts whoever issues it. */
  it.each([
    ["an UPDATE of the original reference's coordinate", (db: VigilDb) =>
      db.update(locationSnapshots).set({ latitude: 0 }).run()],
    ["an UPDATE repointing the shipment's reference", (db: VigilDb) =>
      db.update(shipments).set({ referenceSnapshotId: "other" }).run()],
    ["a DELETE of a correction", (db: VigilDb) => db.delete(locationCorrections).run()],
    ["a DELETE of a snapshot", (db: VigilDb) => db.delete(locationSnapshots).run()],
  ])("refuses %s", (_label, mutate) => {
    const db = freshDb();
    const history = created(db, "k-immutable");
    appendCorrection(db, { shipmentId: history.shipment.shipmentId, to: NEAR_BANGSAR_B, boundary: FIXTURE_BOUNDARY, nowIso: NOW });
    expect(() => mutate(db)).toThrow(/append-only/);
    expect(getShipment(db, history.shipment.shipmentId)!.originalReference).toEqual(history.originalReference);
  });
});

describe("the online scenario, run through the real agent", () => {
  it("puts the confirmed coordinate on the parcel exactly, with no doorstep jitter", () => {
    const history = created(freshDb(), "k-exact");
    const { scenario } = buildOnlineScenario(history, { world: WORLD, startMs: START_MS });
    expect(scenario.parcels[0].recipientPoint).toEqual({
      latitude: NEAR_AMPANG.latitude,
      longitude: NEAR_AMPANG.longitude,
    });
  });

  it("sets every event id from the shipment id, and two shipments never share one", () => {
    const db = freshDb();
    const a = buildOnlineScenario(created(db, "k-id-a"), { world: WORLD, startMs: START_MS }).scenario;
    const b = buildOnlineScenario(created(db, "k-id-b"), { world: WORLD, startMs: START_MS }).scenario;
    const idsA = a.timeline.map((e) => e.event.eventID);
    expect(idsA[0]).toBe(eventIdFor(a.id.slice("B-O-".length), "collection"));
    expect(new Set([...idsA, ...b.timeline.map((e) => e.event.eventID)]).size).toBe(12);
  });

  it("puts no cell or WiFi in the scan: nothing true could be reported, so nothing is invented", () => {
    const history = created(freshDb(), "k-radio");
    const delivery = buildOnlineScenario(history, { world: WORLD, startMs: START_MS }).scenario.timeline.at(-1)!;
    const signals = (delivery.raw.sensorElementList as Array<Record<string, Record<string, unknown>>>)[0][
      "vigil:signals"
    ];
    expect(signals.cell).toBeUndefined();
    expect(signals.wifi).toBeUndefined();
  });

  it("leaves every leg before delivery unchanged when the simulated scan moves", () => {
    const history = created(freshDb(), "k-stable");
    const a = buildOnlineScenario(history, { world: WORLD, startMs: START_MS }).scenario.timeline;
    const b = buildOnlineScenario(history, {
      world: WORLD,
      startMs: START_MS,
      scan: { latitude: 3.166, longitude: 101.731 },
    }).scenario.timeline;
    expect(JSON.stringify(a.slice(0, -1).map((e) => e.raw))).toBe(JSON.stringify(b.slice(0, -1).map((e) => e.raw)));
    expect(JSON.stringify(a.at(-1)!.raw)).not.toBe(JSON.stringify(b.at(-1)!.raw));
  });

  it("skips I1 as not_evaluated — not clear — and records why", async () => {
    const history = created(freshDb(), "k-i1");
    const { scenario, locationGap } = buildOnlineScenario(history, { world: WORLD, startMs: START_MS });
    const ingested = await ingest(scenario);
    const delivery = ingested.legs.at(-1)!;

    const skipped = delivery.engineResult!.coverage.notEvaluated.map((n) => n.id);
    expect(skipped).toContain("I1");
    expect(delivery.engineResult!.flags.map((f) => f.id)).not.toContain("I1");
    expect(delivery.resolution.missing.map((m) => m.what)).toContain("referenceSites");
    expect(locationGap).toBe(UNREGISTERED_LOCATION_GAP);
    expect(delivery.gateResult?.decision).toBe("accept");
  });

  /**
   * The count is READ from the engine's result, never written down: it depends
   * on the input, and a sentence claiming a fixed number for arbitrary points
   * would be wrong the first time a scan differed. This test pins only the
   * relationship — evaluated plus skipped is the whole rule set.
   */
  it("reports coverage from the result, consistent with what was skipped", async () => {
    const history = created(freshDb(), "k-coverage");
    const ingested = await ingest(buildOnlineScenario(history, { world: WORLD, startMs: START_MS }).scenario);
    const coverage = ingested.legs.at(-1)!.engineResult!.coverage;
    expect(coverage.evaluated + coverage.notEvaluated.length).toBe(coverage.total);
    expect(coverage.evaluated).toBeLessThan(coverage.total);
    expect(ingested.legs.at(-1)!.coverage?.inconsistency?.evaluated).toBe(coverage.evaluated);
  });

  it("still runs I7 and I8 at an arbitrary point: clear when clean, triggered when faulted", async () => {
    const db = freshDb();
    const clean = await ingest(
      buildOnlineScenario(created(db, "k-i7-clean"), { world: WORLD, startMs: START_MS }).scenario,
    );
    const cleanSkipped = clean.legs.at(-1)!.engineResult!.coverage.notEvaluated.map((n) => n.id);
    expect(cleanSkipped).not.toContain("I7");
    expect(cleanSkipped).not.toContain("I8");

    const faulted = await ingest(
      buildOnlineScenario(created(db, "k-i7-fault"), {
        world: WORLD,
        startMs: START_MS,
        deliveryOverrides: { mockLocation: true, integrityFailed: true },
      }).scenario,
    );
    const flags = faulted.legs.at(-1)!.engineResult!.flags.map((f) => f.id);
    expect(flags).toContain("I7");
    expect(flags).toContain("I8");
  });

  /**
   * THE STALE-RECORD BEHAVIOUR, KEPT. A correction reaches the courier, not the
   * registry: the parcel still carries the original point, the courier scans at
   * the corrected one, and the distance rules find them apart. Nothing tells
   * the engine the correction was honest.
   */
  it("keeps the stale-record behaviour: a corrected delivery is measured against the original point", async () => {
    const db = freshDb();
    const history = created(db, "k-stale");
    const far = { latitude: 3.13, longitude: 101.62, addressClaim: "New address, far west" };
    appendCorrection(db, { shipmentId: history.shipment.shipmentId, to: far, boundary: FIXTURE_BOUNDARY, nowIso: NOW });
    const corrected = getShipment(db, history.shipment.shipmentId)!;

    const { scenario } = buildOnlineScenario(corrected, { world: WORLD, startMs: START_MS });
    expect(scenario.parcels[0].recipientPoint).toEqual({
      latitude: NEAR_AMPANG.latitude,
      longitude: NEAR_AMPANG.longitude,
    });
    const ingested = await ingest(scenario);
    const flags = ingested.legs.at(-1)!.engineResult!.flags.map((f) => f.id);
    expect(flags.some((id) => id === "I10" || id === "I11")).toBe(true);
    expect(flags).not.toContain("I1");
  });

  it("seals byte-identical verdicts with no LLM, with fake A and with fake B", async () => {
    const history = created(freshDb(), "k-parity");
    const verdicts = async (llm?: NodeDeps["llm"]) => {
      const { scenario } = buildOnlineScenario(history, { world: WORLD, startMs: START_MS });
      const ingested = await ingest(scenario, llm);
      return JSON.stringify(ingested.legs.map((leg) => leg.verdict));
    };
    const none = await verdicts(undefined);
    const fakeA = {
      provider: scriptedProvider("fake-A", {
        plan: { tools: ["check_traffic_weather"], rationale: "A" },
        explain: { summary: "A: nothing unusual here.", citations: [] },
      }),
    };
    const fakeB = {
      provider: scriptedProvider("fake-B", {
        plan: { tools: ["fetch_route_history"], rationale: "B" },
        explain: { summary: "B: worth a second look.", citations: ["decision"] },
      }),
    };
    expect(await verdicts(fakeA)).toBe(none);
    expect(await verdicts(fakeB)).toBe(none);
  });
});


describe("the placeholder boundary, used until a sourced one is confirmed", () => {
  const placeholder = placeholderBoundary();

  it("is labelled a placeholder everywhere and never called the city boundary", () => {
    expect(placeholder.placeholder).toBe(true);
    expect(placeholder.version.startsWith("placeholder-")).toBe(true);
    expect(boundaryLabel(placeholder)).toMatch(/^Boundary data pending confirmation/);
    expect(boundaryLabel(placeholder)).toMatch(/not an administrative area/);
    expect(placeholder.source).toMatch(/not an administrative boundary/);
  });

  it("is circles around the three existing depots, not a rectangle", () => {
    expect(placeholder.area.geometry.type).toBe("MultiPolygon");
    expect(placeholder.area.geometry.coordinates).toHaveLength(DEPOTS.length);
  });

  /** The radius is derived from the cached set, so the set is inside it by construction. Measured, not assumed. */
  it("accepts every cached address, and refuses a point well beyond the network", () => {
    for (const address of ADDRESSES) expect(checkPoint(address, placeholder).ok).toBe(true);
    const seremban = { latitude: 2.7297, longitude: 101.9381 };
    expect(checkPoint(seremban, placeholder)).toMatchObject({ ok: false, code: "outside" });
    expect(checkPoint(seremban, placeholder).ok ? "" : (checkPoint(seremban, placeholder) as { reason: string }).reason).toMatch(
      /pending confirmation/,
    );
  });

  it("is what loads when no confirmed boundary file exists, and its version is stamped on the snapshot", () => {
    const loaded = loadServiceBoundary(join(tmpdir(), "vigil-no-such-boundary.json"));
    expect(loaded.version).toBe(placeholder.version);
    const db = freshDb();
    const result = createShipment(db, { request: REQUEST, idempotencyKey: "k-placeholder", boundary: loaded, nowIso: NOW });
    if (result.status !== "created") throw new Error(result.status);
    expect(getShipment(db, result.shipment.shipmentId)!.originalReference.boundaryVersion).toBe(placeholder.version);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type VigilDb } from "@/lib/db/client";
import { applyMigrations, createMigratedDb } from "@/lib/db/migrate";
import { locationSnapshots, shipments } from "@/lib/db/schema";
import { simulationOf, type RandomSimulationConfig } from "@/lib/simulation/config";
import { placeholderBoundary } from "./service-area";
import { createShipment, getShipment, requestHashOf, type ShipmentRequest } from "./store";

const CONFIG: RandomSimulationConfig = { mode: "randomized", seed: "Demo_2026-10-25", version: "signals-v1" };
const REQUEST: ShipmentRequest = {
  origin: { latitude: 3.13, longitude: 101.67, addressClaim: "12 Jalan Contoh, Bangsar" },
  destination: { latitude: 3.165, longitude: 101.73 },
  declaredValueSen: 12000,
  recipientChannel: "+60111234567",
};
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function freshDb() {
  const db = createMigratedDb(":memory:");
  cleanups.push(() => closeDb(db));
  return db;
}
function create(db: VigilDb, request: ShipmentRequest = { ...REQUEST, simulation: CONFIG }, key = "simulation-retry") {
  return createShipment(db, { request, idempotencyKey: key, boundary: placeholderBoundary(), nowIso: "2026-10-25T09:00:00+08:00" });
}
function created(db: VigilDb, request?: ShipmentRequest) {
  const result = create(db, request);
  if (result.status !== "created") throw new Error(result.status);
  return result.shipment;
}

describe("persisted simulation requests", () => {
  it("stores normalized inputs while leaving realized evidence for assignment", () => {
    const db = freshDb();
    const row = created(db);
    expect(JSON.parse(row.simulationJson!)).toEqual(CONFIG);
    expect(row.simulationSnapshotJson).toBeNull();
    expect(simulationOf(getShipment(db, row.shipmentId)!.shipment)).toEqual(CONFIG);
  });

  it("keeps normal/mock request hashes byte-identical to the committed store", () => {
    expect(requestHashOf(REQUEST)).toBe("b24047a60786d6120c0cdafd3a3dfecef7133951c07db58ef4ca68bb75ccc259");
    expect(requestHashOf({ ...REQUEST, demoCondition: "normal" })).toBe(requestHashOf(REQUEST));
    expect(requestHashOf({ ...REQUEST, demoCondition: "mock_location" })).toBe("ef5086c365c2c4bf1b1ce501f2543598fc0e95b9096971bf39165e075df63531");
    const row = created(freshDb(), REQUEST);
    expect(row.simulationJson).toBeNull();
    expect(row.simulationSnapshotJson).toBeNull();
  });

  it("replays the same config without extra snapshots and conflicts on a changed seed or mode", () => {
    const db = freshDb();
    const row = created(db);
    const reordered = { version: "signals-v1", seed: CONFIG.seed, mode: "randomized" } as const;
    const retry = create(db, { ...REQUEST, simulation: reordered });
    expect(retry).toEqual({ status: "replayed", shipment: row });
    expect(create(db, { ...REQUEST, simulation: { ...CONFIG, seed: "another-seed" } }).status).toBe("conflict");
    expect(create(db, REQUEST).status).toBe("conflict");
    expect(db.select().from(shipments).all()).toHaveLength(1);
    expect(db.select().from(locationSnapshots).all()).toHaveLength(2);
  });

  it("persists randomization independently of advanced mock location", () => {
    const db = freshDb();
    const row = created(db, { ...REQUEST, simulation: CONFIG, demoCondition: "mock_location" });
    expect(row.demoCondition).toBe("mock_location");
    expect(simulationOf(row)).toEqual(CONFIG);
    expect(create(db, { ...REQUEST, simulation: CONFIG, demoCondition: "normal" }).status).toBe("conflict");
  });

  it("reloads the same configuration and retries across database connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigil-simulation-reload-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "test.db");
    const first = createMigratedDb(path);
    cleanups.push(() => closeDb(first));
    const row = created(first);
    closeDb(first);
    const second = createMigratedDb(path);
    cleanups.push(() => closeDb(second));
    expect(simulationOf(getShipment(second, row.shipmentId)!.shipment)).toEqual(CONFIG);
    expect(create(second)).toEqual({ status: "replayed", shipment: row });
    expect(create(second, { ...REQUEST, simulation: { ...CONFIG, seed: "changed" } }).status).toBe("conflict");
  });

  it("validates even direct store callers before persisting an unsupported config", () => {
    const db = freshDb();
    const request = { ...REQUEST, simulation: { ...CONFIG, version: "signals-v2" } } as unknown as ShipmentRequest;
    expect(() => create(db, request)).toThrow();
    expect(db.select().from(shipments).all()).toHaveLength(0);
    expect(db.select().from(locationSnapshots).all()).toHaveLength(0);
  });

  it("protects config and confirmed inputs while permitting exactly one snapshot fill", () => {
    const db = freshDb();
    const row = created(db);
    const replace = (values: Partial<typeof shipments.$inferInsert>) => db.update(shipments).set(values).where(eq(shipments.shipmentId, row.shipmentId)).run();
    expect(() => replace({ simulationJson: JSON.stringify({ ...CONFIG, seed: "changed" }) })).toThrow(/append-only/);
    expect(() => replace({ simulationSnapshotJson: "{}", declaredValueSen: 1 })).toThrow(/append-only/);
    expect(() => replace({ simulationSnapshotJson: "{}", simulationJson: null })).toThrow(/append-only/);
    replace({ simulationSnapshotJson: "{}" });
    expect(getShipment(db, row.shipmentId)!.shipment.simulationSnapshotJson).toBe("{}");
    expect(() => replace({ simulationSnapshotJson: "{\"changed\":true}" })).toThrow(/append-only/);
    expect(() => replace({ simulationSnapshotJson: null })).toThrow(/append-only/);
    expect(() => db.delete(shipments).run()).toThrow(/append-only/);
    expect(simulationOf(getShipment(db, row.shipmentId)!.shipment)).toEqual(CONFIG);
  });

  it("keeps every approved column immutable even during the first snapshot fill", () => {
    const db = freshDb();
    const row = created(db);
    const changes: Array<Partial<typeof shipments.$inferInsert>> = [
      { shipmentId: "changed" }, { idempotencyKey: "changed" }, { requestHash: "changed" },
      { originSnapshotId: "changed" }, { referenceSnapshotId: "changed" },
      { originDepot: "changed" }, { destinationDepot: "changed" }, { local: !row.local },
      { declaredValueSen: 1 }, { codAmountSen: 1 }, { recipientChannel: "changed" },
      { recipientName: "changed" }, { demoCondition: "mock_location" },
      { simulationJson: JSON.stringify({ ...CONFIG, seed: "changed" }) }, { createdAt: "changed" },
    ];
    for (const change of changes) {
      expect(() => db.update(shipments).set({ ...change, simulationSnapshotJson: "{}" }).run()).toThrow(/append-only/);
    }
    expect(getShipment(db, row.shipmentId)!.shipment).toEqual(row);
  });

  it("cannot attach simulation evidence to a normal shipment", () => {
    const db = freshDb();
    const row = created(db, REQUEST);
    expect(() => db.update(shipments).set({ simulationSnapshotJson: "{}" }).run()).toThrow(/append-only/);
    expect(getShipment(db, row.shipmentId)!.shipment.simulationSnapshotJson).toBeNull();
  });

  it.each(["{", "null", '{"mode":"randomized","seed":"valid"}', '{"mode":"randomized","seed":"valid","version":"signals-v2"}'])(
    "fails closed when a stored row has corrupt simulation configuration: %s", (simulationJson) => {
      const db = freshDb();
      const row = created(db);
      // Model corruption outside the append-only application path; do not relax the production trigger.
      db.$client.exec("DROP TRIGGER shipments_no_update");
      db.$client.prepare("UPDATE shipments SET simulation_json = ? WHERE shipment_id = ?").run(simulationJson, row.shipmentId);
      expect(() => simulationOf(getShipment(db, row.shipmentId)!.shipment)).toThrow();
    },
  );

  it("upgrades an old database without changing a legacy row or its retry hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigil-simulation-migration-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const folder = join(dir, "migrations");
    mkdirSync(join(folder, "meta"), { recursive: true });
    const source = join(process.cwd(), "lib/db/migrations");
    const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 11);
    writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) copyFileSync(join(source, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    const db = createDb(":memory:");
    cleanups.push(() => closeDb(db));
    migrate(db, { migrationsFolder: folder });
    // Insert through SQL: the old schema cannot be queried with the new Drizzle columns.
    db.$client.exec(`
      INSERT INTO location_snapshots (snapshot_id,shipment_id,purpose,latitude,longitude,address_claim,source,confirmed_at,boundary_version)
      VALUES ('old-origin','old-shipment','origin',3.13,101.67,'12 Jalan Contoh, Bangsar','map_confirmed','2026-10-24','test'),
             ('old-reference','old-shipment','delivery_reference',3.165,101.73,'','map_confirmed','2026-10-24','test');
      INSERT INTO shipments (shipment_id,idempotency_key,request_hash,origin_snapshot_id,reference_snapshot_id,origin_depot,destination_depot,local,declared_value_sen,cod_amount_sen,recipient_channel,created_at)
      VALUES ('old-shipment','old-key','b24047a60786d6120c0cdafd3a3dfecef7133951c07db58ef4ca68bb75ccc259','old-origin','old-reference','Bangsar','Ampang',0,12000,0,'+60111234567','2026-10-24');
    `);
    applyMigrations(db);
    const old = getShipment(db, "old-shipment")!.shipment;
    expect(old.simulationJson).toBeNull();
    expect(old.simulationSnapshotJson).toBeNull();
    expect(simulationOf(old)).toBeUndefined();
    expect(create(db, REQUEST, "old-key")).toEqual({ status: "replayed", shipment: old });
    expect(simulationOf(created(db))).toEqual(CONFIG);
  });
});

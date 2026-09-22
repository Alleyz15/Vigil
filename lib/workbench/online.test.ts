import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/db/client";
import { createMigratedDb } from "@/lib/db/migrate";
import type { ServiceBoundary } from "@/lib/shipment";
import { shipmentStorePath } from "@/lib/shipment";
import { createWorkbench, type OperatorWorkbench } from "./service";

/**
 * Online shipments through the workbench: the same entries, the same queue, the
 * same detail view as every other shipment, plus the one thing they have that
 * the others do not — a location with no registered reference sites, said where
 * the operator reads the verdict.
 *
 * The boundary is a TEST FIXTURE rectangle, not Kuala Lumpur.
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
      coordinates: [[[101.6, 3.1], [101.76, 3.1], [101.76, 3.2], [101.6, 3.2], [101.6, 3.1]]],
    },
  },
};

const REQUEST = {
  origin: { latitude: 3.13, longitude: 101.67, addressClaim: "12 Jalan Contoh, Bangsar" },
  destination: { latitude: 3.165, longitude: 101.73, addressClaim: "Lot 8, Jalan Percubaan, Ampang" },
  declaredValueSen: 12_000,
  recipientChannel: "+60111234567",
};

let workbench: OperatorWorkbench;
const store = createMigratedDb(":memory:");

beforeAll(async () => {
  workbench = await createWorkbench({ scenarioIds: ["S0"] });
  workbench.configureOnline({ store, boundary: FIXTURE_BOUNDARY });
}, 120_000);

afterAll(() => {
  workbench.close();
  closeDb(store);
});

describe("an online shipment in the workbench", () => {
  it("runs to out-for-delivery, returns the same run on a retry, and refuses a reused key", async () => {
    const created = await workbench.createOnlineShipment(REQUEST, "wb-key-1");
    expect(created).toMatchObject({ status: "created", running: true });
    if (created.status !== "created" || !created.running) return;
    expect(created.eventIds).toHaveLength(5);

    const replayed = await workbench.createOnlineShipment(REQUEST, "wb-key-1");
    expect(replayed).toMatchObject({ status: "replayed", running: true, shipmentId: created.shipmentId });

    const conflict = await workbench.createOnlineShipment({ ...REQUEST, declaredValueSen: 1 }, "wb-key-1");
    expect(conflict.status).toBe("conflict");
  });

  it("appears in the sender's pending-delivery surface with its confirmed point", async () => {
    const created = await workbench.createOnlineShipment(REQUEST, "wb-key-pending");
    if (created.status !== "created") throw new Error(created.status);

    expect(workbench.listSenderShipments()).toContainEqual(
      expect.objectContaining({
        kind: "online",
        runId: `B-O-${created.shipmentId}`,
        shipmentId: created.shipmentId,
        recordedAddress: REQUEST.destination.addressClaim,
        delivered: false,
      }),
    );
  });

  it("refuses a point outside the boundary with the field that was wrong", async () => {
    const result = await workbench.createOnlineShipment(
      { ...REQUEST, destination: { latitude: 3.3, longitude: 101.7, addressClaim: "north" } },
      "wb-key-out",
    );
    expect(result).toMatchObject({ status: "rejected", field: "destination", code: "outside" });
  });

  it("corrects, delivers at the corrected point, then refuses a correction after delivery", async () => {
    const created = await workbench.createOnlineShipment(REQUEST, "wb-key-2");
    if (created.status !== "created") throw new Error(created.status);
    const id = created.shipmentId;

    const corrected = workbench.correctOnlineShipment(id, {
      latitude: 3.13,
      longitude: 101.62,
      addressClaim: "New address, far west",
    });
    expect(corrected).toEqual({ ok: true, sequence: 1 });

    const delivered = await workbench.deliverOnlineShipment(id);
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;

    const detail = workbench.getHandoff(delivered.eventId)!;
    // The engine measured the scan at the corrected point against the ORIGINAL one.
    expect(detail.flags.map((f) => f.id).some((f) => f === "I10" || f === "I11")).toBe(true);
    expect(detail.addressCorrection).toMatchObject({
      fromLabel: "Lot 8, Jalan Percubaan, Ampang",
      toLabel: "New address, far west",
    });
    expect(detail.locationEvidence).toMatchObject({
      gap: { code: "reference_sites_unregistered" },
      scanSource: "simulation",
    });

    const late = workbench.correctOnlineShipment(id, { latitude: 3.14, longitude: 101.7, addressClaim: "later" });
    expect(late).toMatchObject({ ok: false, code: "delivered" });

    const stored = workbench.onlineShipment(id)!;
    expect(stored.history.originalReference.addressClaim).toBe("Lot 8, Jalan Percubaan, Ampang");
    expect(stored.history.corrections).toHaveLength(1);
  }, 60_000);

  it("carries no location-evidence note on a seeded shipment, whose address is registered", () => {
    const seeded = workbench.listHandoffs().items.find((item) => item.scenarioId === "S0")!;
    expect(workbench.getHandoff(seeded.eventId)!.locationEvidence).toBeNull();
  });
});

describe("the store's location on disk", () => {
  it("defaults to data/db/shipments.db and honours VIGIL_SHIPMENT_DB_PATH", () => {
    expect(shipmentStorePath({})).toBe("./data/db/shipments.db");
    expect(shipmentStorePath({ VIGIL_SHIPMENT_DB_PATH: "/tmp/x.db" })).toBe("/tmp/x.db");
  });
});

describe("the boundary note on every answer", () => {
  it("names the boundary a point was checked against, and says when it is not a placeholder", async () => {
    const result = await workbench.createOnlineShipment(REQUEST, "wb-key-note");
    expect(result.boundary).toEqual({
      version: "test-fixture-rectangle-v1",
      placeholder: false,
      // The fixture carries no attribution, so the label falls back to the version.
      label: "Checked against test-fixture-rectangle-v1",
      extractedAt: null,
    });
  });
});

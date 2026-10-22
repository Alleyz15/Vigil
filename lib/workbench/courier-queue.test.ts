import { afterAll, describe, expect, it } from "vitest";
import { createMigratedDb } from "@/lib/db/migrate";
import { closeDb } from "@/lib/db/client";
import type { ServiceBoundary } from "@/lib/shipment";
import { createWorkbench, type OperatorWorkbench } from "./service";

const BOUNDARY: ServiceBoundary = {
  version: "courier-queue-fixture-v1",
  source: "test fixture",
  licence: "n/a",
  area: {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[[101.6, 3.0], [101.8, 3.0], [101.8, 3.25], [101.6, 3.25], [101.6, 3.0]]],
    },
  },
};

const ONLINE_REQUEST = {
  origin: {
    latitude: 3.13,
    longitude: 101.67,
    resolved: { label: "Bangsar pickup", by: "search" as const, ref: "node/origin" },
  },
  destination: {
    latitude: 3.165,
    longitude: 101.73,
    resolved: { label: "Ampang delivery", by: "search" as const, ref: "node/destination" },
  },
  declaredValueSen: 12_000,
  recipientChannel: "+60111234567",
};

describe("unified courier queue", () => {
  let workbench: OperatorWorkbench;
  const store = createMigratedDb(":memory:");

  afterAll(() => {
    workbench?.close();
    closeDb(store);
  });

  it("returns one courier identity with seeded, registered and online work assigned to that courier", async () => {
    workbench = await createWorkbench({ scenarioIds: ["S0", "S1"], courierDrafts: true });
    workbench.configureOnline({ store, boundary: BOUNDARY });

    const registered = await workbench.runBuilt(
      {
        originIndex: 0,
        destinationIndex: 20,
        declaredValueSen: 65_000,
        recipientChannel: "+60119990001",
        fault: "gps_spoof",
        seed: "courier-queue-registered",
      },
      { holdDelivery: true },
    );
    expect(registered.ok).toBe(true);

    const online = await workbench.createOnlineShipment(ONLINE_REQUEST, "courier-queue-online");
    expect(online.status).toBe("created");

    const workspace = workbench.courierWorkspace();

    expect(workspace.identity).toMatchObject({ role: "courier", subject: "CR-1001" });
    expect(workspace.items.map((item) => item.source).sort()).toEqual(["online", "registered", "seeded"]);
    expect(workspace.items.map((item) => item.scenarioId)).toContain("S1");
    expect(workspace.items.map((item) => item.scenarioId)).not.toContain("S0");
    expect(new Set(workspace.items.map((item) => item.courierId))).toEqual(new Set([workspace.identity.subject]));
    expect(workspace.items.find((item) => item.source === "online")).toMatchObject({
      route: {
        origin: {
          label: "Bangsar pickup",
          source: "geocoder_search",
          coordinate: "3.130000, 101.670000",
          senderClaim: null,
        },
        destination: {
          label: "Ampang delivery",
          source: "geocoder_search",
          coordinate: "3.165000, 101.730000",
          senderClaim: null,
        },
      },
    });
  }, 60_000);

  it("submits registered and seeded work through one courier contract", async () => {
    const workspace = workbench.courierWorkspace();
    const registered = workspace.items.find((item) => item.source === "registered")!;
    const seeded = workspace.items.find((item) => item.source === "seeded")!;

    const unsigned = await workbench.submitCourierHandoff(registered.handoffId, { signed: false });
    expect(unsigned.outcome.kind).toBe("signature_missing");
    expect(workbench.listSenderShipments().find((item) => item.runId === registered.runId)?.delivered).toBe(false);

    const delivered = await workbench.submitCourierHandoff(registered.handoffId, { signed: true });
    expect(delivered.item.attempts.map((attempt) => attempt.outcome.kind)).toEqual(["signature_missing", "signature_insufficient"]);
    expect(workbench.listSenderShipments().find((item) => item.runId === registered.runId)?.delivered).toBe(true);
    expect(workbench.getHandoff(delivered.item.eventId)?.summary.courier.courierId).toBe(workspace.identity.subject);

    const seededResult = await workbench.submitCourierHandoff(seeded.handoffId, { signed: true });
    expect(seededResult.outcome.kind).toBe("signature_insufficient");
    expect(seededResult.item.courierId).toBe(workspace.identity.subject);
  }, 60_000);

  it("submits an online point-to-point shipment through the same courier contract", async () => {
    const online = workbench.courierWorkspace().items.find((item) => item.source === "online")!;
    const delivered = await workbench.submitCourierHandoff(online.handoffId, { signed: true });
    const sealed = workbench.getHandoff(delivered.item.eventId)!;

    expect(delivered.item.attempts).toHaveLength(1);
    expect(workbench.listSenderShipments().find((item) => item.shipmentId === online.handoffId.slice("online:".length))?.delivered).toBe(true);
    expect(workbench.getHandoff(delivered.item.eventId)?.locationEvidence).toMatchObject({
      gap: { code: "reference_sites_unregistered" },
      scanSource: "simulation",
    });
    expect(sealed).toMatchObject({
      route: {
        origin: { label: "Bangsar pickup", source: "geocoder_search" },
        destination: { label: "Ampang delivery", source: "geocoder_search" },
        custody: {
          originDepot: { label: expect.stringContaining("depot") },
          destinationDepot: { label: expect.stringContaining("depot") },
        },
      },
    });

    expect(sealed.map.locations.map((location) => location.kind)).toEqual([
      "sender_reference",
      "origin_depot",
      "destination_depot",
      "delivery",
    ]);
    expect(sealed.map.locations.map((location) => location.mapLabel)).toEqual([
      "Bangsar pickup · Sender",
      expect.stringMatching(/· Origin depot$/),
      expect.stringMatching(/· Destination depot$/),
      "Ampang delivery · Delivery",
    ]);
    expect(sealed.timeline.map((leg) => leg.locationLabel)).toEqual([
      sealed.route?.custody?.originDepot.label,
      sealed.route?.custody?.originDepot.label,
      sealed.route?.custody?.originDepot.label,
      sealed.route?.custody?.destinationDepot.label,
      sealed.route?.custody?.destinationDepot.label,
      "Ampang delivery",
    ]);

    const duplicate = await workbench.submitCourierHandoff(online.handoffId, { signed: true });
    expect(duplicate.outcome.kind).toBe("replay_noop");

    const afterDuplicate = workbench.getHandoff(delivered.item.eventId)!;
    expect(afterDuplicate.runs.map((run) => run.ledgerStatus)).toEqual(["recorded", "noop"]);
    expect(afterDuplicate.authoritativeRun.ledgerStatus).toBe("recorded");
    expect(afterDuplicate.summary.inconsistency).toEqual(sealed.summary.inconsistency);
    expect(afterDuplicate.summary.pattern).toEqual(sealed.summary.pattern);
    expect(afterDuplicate.summary.coverageLine).toBe("13 of 16 checks evaluable");
    expect(afterDuplicate.summary.patternCoverageLine).toBe("3 of 5 checks evaluable");
    expect(afterDuplicate.credential).toMatchObject({ courierValid: true, operatorValid: false });
    expect(afterDuplicate.ledger.sequence).toBe(sealed.ledger.sequence);
    expect(afterDuplicate.plan).toEqual(sealed.plan);
    expect(afterDuplicate.explanation).toEqual(sealed.explanation);
  }, 60_000);
});

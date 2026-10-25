import { describe, expect, it } from "vitest";
import { buildScenario, buildWorld, makeRng, type ScenarioId } from "@/lib/generate";
import { EpcisEvent, vigilSignalsOf } from "@/lib/epcis";
import { buildShipmentMapModel, type MapLocation } from "./map-model";

const SEED = "vigil-2026";
const START_MS = Date.parse("2026-09-07T14:30:00+08:00");

function modelFor(id: ScenarioId) {
  const world = buildWorld(SEED);
  const scenario = buildScenario(id, { world, rng: makeRng(SEED), startMs: START_MS });
  return buildShipmentMapModel(scenario, world);
}

describe("shipment map projection", () => {
  it("projects the complete route without inventing missing positions", () => {
    const model = modelFor("S0");

    expect(model.route).toHaveLength(6);
    expect(model.route.every((leg) => leg.point !== null)).toBe(true);
    expect(model.route.map((leg) => leg.leg)).toEqual([
      "collection",
      "sortation",
      "linehaul_departure",
      "linehaul_arrival",
      "out_for_delivery",
      "delivery",
    ]);
    expect(model.locations.map((location) => location.kind)).toEqual([
      "origin_depot",
      "destination_depot",
      "delivery",
    ]);
    expect(model.locations).toHaveLength(3);
  });

  it("links S1 claimed GPS and independently located cell evidence to I1", () => {
    const model = modelFor("S1");
    const claimed = model.overlays.find((feature) => feature.id === "s1-claimed-position");
    const cell = model.overlays.find((feature) => feature.id === "s1-cell-coverage");
    const link = model.overlays.find((feature) => feature.id === "s1-position-link");

    expect(claimed).toMatchObject({ kind: "marker", evidenceId: "I1" });
    expect(cell).toMatchObject({ kind: "circle", evidenceId: "I1" });
    expect(link).toMatchObject({ kind: "line", evidenceId: "I1" });
    expect(link?.points).toHaveLength(2);
    expect(claimed?.point).not.toEqual(cell?.point);
  });

  it("shows S6 as reported GPS uncertainty rather than a contradiction", () => {
    const model = modelFor("S6");
    const uncertainty = model.overlays.find((feature) => feature.id === "s6-gps-uncertainty");

    expect(uncertainty).toMatchObject({
      kind: "circle",
      evidenceId: null,
      radiusMeters: 140,
      provenance: "synthetic device signal",
    });
  });

  it("keeps S2 scan and recipient clusters as two separate observed sets", () => {
    const model = modelFor("S2");
    const scans = model.overlays.filter((feature) => feature.group === "s2-scans");
    const recipients = model.overlays.filter((feature) => feature.group === "s2-recipients");

    expect(scans).toHaveLength(40);
    expect(recipients).toHaveLength(40);
    expect(model.overlays.some((feature) => feature.evidenceId === "P4")).toBe(false);
  });

  it("does not invent a geographic polygon for S4's EPC-prefix mandate", () => {
    const model = modelFor("S4");

    expect(model.overlays.some((feature) => feature.kind === "polygon")).toBe(false);
    expect(model.notices).toContainEqual({
      id: "s4-scope-not-spatial",
      evidenceId: "H2",
      title: "Mandate scope is not geographic",
      detail: expect.stringContaining("EPC prefix"),
    });
  });

  it("shows S3's real same-position payload reuse without inventing a second location", () => {
    const model = modelFor("S3");
    const reuse = model.overlays.find((feature) => feature.id === "s3-event-reuse");

    expect(reuse).toMatchObject({ kind: "marker", evidenceId: "H4" });
    expect(reuse?.label).toContain("two payloads");
    expect(model.notices).toContainEqual({
      id: "s3-reuse-same-position",
      evidenceId: "H4",
      title: "Payload changed; position did not",
      detail: expect.stringContaining("No second position is drawn"),
    });
  });
});

describe("submitted delivery map evidence", () => {
  const reference = { latitude: 3.165, longitude: 101.73 };
  const scan = { latitude: 3.13, longitude: 101.62, accuracyMeters: 8 };

  function fixture(point: typeof scan | null = scan, deliveryFlags: string[] = ["I10"]) {
    const world = buildWorld(SEED);
    const scenario = buildScenario("S0", { world, rng: makeRng(SEED), startMs: START_MS });
    const original = scenario.timeline.find((built) => built.leg === "delivery")!;
    const submitted = structuredClone(original.event);
    const signals = vigilSignalsOf(submitted)!;
    if (point) signals.gps!.point = point;
    else delete signals.gps;
    const locations: MapLocation[] = [{
      id: "delivery", kind: "delivery", label: "Recorded recipient reference",
      mapLabel: "Recorded reference", detail: "Original recipient record.",
      point: reference, monitored: true,
    }];
    return { world, scenario, original, options: {
      locations, deliveryEvent: EpcisEvent.parse(submitted), deliveryFlags,
    } };
  }

  it.each([{ flags: ["I10"] }, { flags: ["I11"] }, { flags: ["I10", "I11"] }])(
    "shows submitted GPS against the original reference for emitted flags $flags",
    ({ flags }) => {
      const { scenario, world, options } = fixture(scan, flags);
      const before = JSON.stringify({ scenario, options });
      const model = buildShipmentMapModel(scenario, world, options);

      expect(model.route.find((leg) => leg.leg === "delivery")?.point).toEqual(scan);
      expect(model.locations).toEqual(options.locations);
      expect(model.overlays).toContainEqual(expect.objectContaining({
        kind: "marker", point: scan, precision: "reported", eventId: options.deliveryEvent.eventID,
        label: "Reported delivery scan", evidenceId: flags[0],
      }));
      const lines = model.overlays.filter((feature) => feature.kind === "line");
      expect(lines.map((line) => line.evidenceId)).toEqual(flags);
      expect(lines.every((line) => JSON.stringify(line.points) === JSON.stringify([scan, reference]))).toBe(true);
      expect(JSON.stringify({ scenario, options })).toBe(before);
    },
  );

  it.each([{ flags: [] }, { flags: ["I1"] }, { flags: ["I12"] }])("does not infer a spatial flag from different coordinates ($flags)", ({ flags }) => {
    const { scenario, world, options } = fixture(scan, flags);
    const model = buildShipmentMapModel(scenario, world, options);

    expect(model.overlays).toContainEqual(expect.objectContaining({ kind: "marker", point: scan, evidenceId: null }));
    expect(model.overlays.some((feature) => feature.kind === "line")).toBe(false);
  });

  it("keeps a same-point delivery as one place even when GPS accuracy metadata differs", () => {
    const { scenario, world, options } = fixture({ ...reference, accuracyMeters: 25 }, []);
    const model = buildShipmentMapModel(scenario, world, options);

    expect(model.route.find((leg) => leg.leg === "delivery")?.point).toEqual({ ...reference, accuracyMeters: 25 });
    expect(model.locations).toEqual(options.locations);
    expect(model.overlays).toEqual([]);
    expect(model.notices).toEqual([]);
  });

  it("does not reuse seeded GPS when the submitted event has no GPS", () => {
    const { scenario, world, options } = fixture(null);
    const model = buildShipmentMapModel(scenario, world, options);

    expect(model.route.find((leg) => leg.leg === "delivery")?.point).toBeNull();
    expect(model.locations).toEqual(options.locations);
    expect(model.overlays).toEqual([]);
    expect(model.notices).toContainEqual(expect.objectContaining({
      evidenceId: "I10", title: "Delivery GPS unavailable", detail: expect.stringContaining("submitted event"),
    }));
  });

  it("replaces the delivery endpoint when the submitted event has a new event ID", () => {
    const { scenario, world, options } = fixture();
    options.deliveryEvent = EpcisEvent.parse({ ...options.deliveryEvent, eventID: "77777777-7777-4777-8777-777777777777" });
    const model = buildShipmentMapModel(scenario, world, options);

    expect(model.route).toHaveLength(scenario.timeline.length);
    expect(model.route.slice(0, -1)).toEqual(buildShipmentMapModel(scenario, world).route.slice(0, -1));
    expect(model.route.at(-1)).toMatchObject({ eventId: options.deliveryEvent.eventID, point: scan });
  });

  it("keeps the scan but reports missing reference geometry instead of guessing a connector", () => {
    const { scenario, world, options } = fixture();
    options.locations = [];
    const model = buildShipmentMapModel(scenario, world, options);

    expect(model.locations).toEqual([]);
    expect(model.overlays).toContainEqual(expect.objectContaining({ kind: "marker", point: scan }));
    expect(model.overlays.some((feature) => feature.kind === "line")).toBe(false);
    expect(model.notices).toContainEqual(expect.objectContaining({
      evidenceId: "I10", title: "Delivery reference unavailable",
    }));
  });

  it("does not infer spatial evidence when deliveryFlags is omitted", () => {
    const { scenario, world, options: { locations, deliveryEvent } } = fixture();
    const options = { locations, deliveryEvent };
    const model = buildShipmentMapModel(scenario, world, options);

    expect(model.overlays).toContainEqual(expect.objectContaining({ kind: "marker", point: scan, evidenceId: null }));
    expect(model.overlays.some((feature) => feature.kind === "line")).toBe(false);
  });

  it("uses the parcel reference when no semantic locations were provided, never seeded delivery GPS", () => {
    const { scenario, world, options: { deliveryEvent, deliveryFlags } } = fixture();
    const options = { deliveryEvent, deliveryFlags };
    const model = buildShipmentMapModel(scenario, world, options);

    expect(model.locations.find((location) => location.kind === "delivery")?.point).toEqual(scenario.parcels[0].recipientPoint);
    expect(model.route.at(-1)?.point).toEqual(scan);
    expect(model.overlays.find((feature) => feature.kind === "line")?.points).toEqual([scan, scenario.parcels[0].recipientPoint]);
  });

  it("updates only the matching delivery in a multi-delivery scenario", () => {
    const world = buildWorld(SEED);
    const scenario = buildScenario("S2", { world, rng: makeRng(SEED), startMs: START_MS });
    const submitted = structuredClone(scenario.timeline[0].event);
    vigilSignalsOf(submitted)!.gps!.point = scan;
    const model = buildShipmentMapModel(scenario, world, { deliveryEvent: EpcisEvent.parse(submitted) });

    expect(model.route[0].point).toEqual(scan);
    expect(model.route.slice(1)).toEqual(buildShipmentMapModel(scenario, world).route.slice(1));
    expect(model.overlays.find((feature) => feature.id === "s2-scan-0")?.point).toEqual(scan);
  });

  it.each(["S1", "S6"] as const)("does not retain stale %s GPS overlays when submitted GPS is missing", (id) => {
    const world = buildWorld(SEED);
    const scenario = buildScenario(id, { world, rng: makeRng(SEED), startMs: START_MS });
    const submitted = structuredClone(scenario.timeline.find((built) => built.leg === "delivery")!.event);
    delete vigilSignalsOf(submitted)!.gps;
    const model = buildShipmentMapModel(scenario, world, { deliveryEvent: EpcisEvent.parse(submitted) });

    expect(model.route.at(-1)?.point).toBeNull();
    expect(model.overlays).toEqual([]);
    expect(model.notices).toContainEqual(expect.objectContaining({ title: "Delivery GPS unavailable" }));
  });

  it("preserves non-spatial source notices alongside the missing submitted GPS notice", () => {
    const world = buildWorld(SEED);
    const scenario = buildScenario("S4", { world, rng: makeRng(SEED), startMs: START_MS });
    const submitted = structuredClone(scenario.timeline.find((built) => built.leg === "delivery")!.event);
    delete vigilSignalsOf(submitted)!.gps;
    const model = buildShipmentMapModel(scenario, world, { deliveryEvent: EpcisEvent.parse(submitted) });

    expect(model.notices.map((notice) => notice.title)).toEqual(["Mandate scope is not geographic", "Delivery GPS unavailable"]);
  });
});

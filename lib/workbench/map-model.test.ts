import { describe, expect, it } from "vitest";
import { buildScenario, buildWorld, makeRng, type ScenarioId } from "@/lib/generate";
import { buildShipmentMapModel } from "./map-model";

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

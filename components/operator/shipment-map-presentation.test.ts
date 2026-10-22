import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("operator shipment map presentation", () => {
  const source = readFileSync(new URL("./shipment-map-client.tsx", import.meta.url), "utf8");

  it("reserves lines for evidence and never animates a vehicle along an inferred route", () => {
    expect(source).not.toContain("AnimatedVehicle");
    expect(source).not.toContain("segments.map");
    expect(source).not.toContain("Current vehicle position");
    expect(source).not.toContain("map.flyTo(");
    expect(source).toContain("map.fitBounds(focus");
    expect(source).toContain("feature.kind === \"line\"");
  });
});

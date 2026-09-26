import { describe, expect, it } from "vitest";
import { clampAnimationProgress, initialViewport } from "./shipment-map-animation";

describe("shipment map animation", () => {
  it("never sends a negative distance into the route interpolator", () => {
    expect(clampAnimationProgress(-0.001)).toBe(0);
    expect(clampAnimationProgress(0.5)).toBe(0.5);
    expect(clampAnimationProgress(1.001)).toBe(1);
  });
});

describe("shipment map initial viewport", () => {
  it("chooses the evidence view immediately when evidence is being revealed", () => {
    expect(initialViewport({ routePointCount: 6, evidencePointCount: 2, revealOverlays: true })).toBe("evidence");
  });

  it("keeps the whole route for an ordinary initial timeline view", () => {
    expect(initialViewport({ routePointCount: 6, evidencePointCount: 0, revealOverlays: false })).toBe("route");
  });
});

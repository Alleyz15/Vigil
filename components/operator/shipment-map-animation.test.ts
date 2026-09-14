import { describe, expect, it } from "vitest";
import { clampAnimationProgress } from "./shipment-map-animation";

describe("shipment map animation", () => {
  it("never sends a negative distance into the route interpolator", () => {
    expect(clampAnimationProgress(-0.001)).toBe(0);
    expect(clampAnimationProgress(0.5)).toBe(0.5);
    expect(clampAnimationProgress(1.001)).toBe(1);
  });
});

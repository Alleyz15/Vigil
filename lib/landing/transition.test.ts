import { describe, expect, it } from "vitest";
import { transitionGradient, transitionProgress } from "./transition";

describe("the hero-to-page transition curve", () => {
  it("starts at the hero's ground and ends at the page's", () => {
    expect(transitionProgress(0)).toBe(0);
    expect(transitionProgress(1)).toBe(1);
  });

  it("never reverses", () => {
    let previous = 0;
    for (let i = 1; i <= 200; i += 1) {
      const value = transitionProgress(i / 200);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  /**
   * THE PROPERTY THAT REMOVES THE SEAM. A linear ramp has the same slope at its
   * ends as in its middle, and that jump from the flat hero is the edge a viewer
   * sees. Here the slope at each end must be a small fraction of the steepest
   * slope in the band.
   */
  it("has near-zero slope where it meets the flat hero and the flat page", () => {
    const h = 1 / 256; // one pixel of a 256px band
    const slope = (t: number) => (transitionProgress(Math.min(1, t + h)) - transitionProgress(Math.max(0, t - h))) / (2 * h);
    let steepest = 0;
    for (let i = 0; i <= 256; i += 1) steepest = Math.max(steepest, slope(i / 256));

    // Eight pixels in from each edge of a 256px band.
    expect(slope(8 / 256) / steepest).toBeLessThan(0.05);
    expect(slope(1 - 8 / 256) / steepest).toBeLessThan(0.05);
  });

  it("keeps the top half mostly unchanged and does most of its turning below", () => {
    expect(transitionProgress(0.5)).toBeLessThan(0.25);
  });

  it("emits a stop at both ends of the band, mixed in oklab from the raw tokens", () => {
    const css = transitionGradient();
    expect(css.startsWith("linear-gradient(to bottom in oklab,")).toBe(true);
    expect(css).toContain("var(--background) 0%) 0%");
    expect(css).toContain("var(--background) 100%) 100%");
    expect(css).not.toContain("--color-");
  });
});

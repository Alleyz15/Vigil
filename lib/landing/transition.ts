/**
 * The dark-hero-to-light-page transition, as a curve and a CSS gradient.
 *
 * WHAT WAS WRONG, MEASURED BEFORE ANYTHING MOVED. The session-22 band was a
 * linear 128px ramp. Its first row and the hero's last row read identical
 * pixels — 16,24,31, the `--foreground` token — so there was no colour mismatch
 * at the seam. The visible edge was a MACH BAND: the hero is flat, then the ramp
 * starts at full slope, and the eye marks a sudden change in slope as a line.
 * The mid-grey "banner" was the linear ramp's constant middle.
 *
 * So the fix is the SHAPE, not the colours: a curve whose slope is zero where it
 * meets the flat hero and zero where it meets the flat page, with most of the
 * change in the lower half — mostly unchanged across the top, turning near the
 * bottom. `smootherstep(t^1.6)`: the exponent skews the turn downward, and
 * smootherstep flattens both ends to zero slope AND zero curvature.
 *
 * Smoothstep was the first choice and measured worse at the light end: skewing
 * the turn that low left it only 74px to flatten, and 8px above the page its
 * slope was still 23% of its steepest — a second, fainter Mach band against the
 * white. Smootherstep, same skew: 4.5%. The top half moves 20% of the way.
 */

/** Share of the way from hero ground to page ground at position t ∈ [0, 1]. */
export function transitionProgress(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  const u = clamped ** 1.6;
  return u * u * u * (u * (u * 6 - 15) + 10);
}

/**
 * The band's background: stops sampled from the curve, mixed in oklab between
 * the two raw tokens. Raw `var(--foreground)` rather than `--color-foreground`,
 * which Tailwind only emits when a utility used it (CLAUDE.md, session 22).
 *
 * 32 stops, one per 8px of a 256px band. A pixel dump of the first 16-stop
 * version showed small flat spots at every stop near the light end: between
 * stops the browser interpolates linearly, so each stop is a slope kink.
 */
export function transitionGradient(steps = 32): string {
  const stops: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const share = Math.round(transitionProgress(t) * 1000) / 10;
    stops.push(`color-mix(in oklab, var(--foreground), var(--background) ${share}%) ${Math.round(t * 1000) / 10}%`);
  }
  return `linear-gradient(to bottom in oklab, ${stops.join(", ")})`;
}

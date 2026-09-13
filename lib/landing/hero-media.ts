/**
 * The hero's background media slot, reserved before the media exists.
 *
 * THE REQUIREMENT: dropping a video in later must be a FILE DROP, not a
 * refactor. So the only edit a future session should need is the two strings
 * below — no JSX changes, no new layers, and above all no revisiting of whether
 * the headline is still readable.
 *
 * That last part is why the scrim ships now rather than with the video. A
 * legibility layer added at the same time as the media is a layer nobody has
 * tested against the media; a legibility layer that has been sitting over the
 * headline for weeks is one whose contrast is already known. Session 21 put the
 * footage in and MEASURED that claim rather than trusting it: worst case 13.67:1
 * on the headline and 5.65:1 on the standfirst across five paused frames, and
 * 1.12:1 with the scrim removed (`npm run qa:capture:landing`).
 *
 * THE CONTRACT STILL HOLDS IN CODE. ITS DESIGN PREMISE DID NOT SURVIVE SESSION 22.
 *
 * "The scrim already guarantees legibility, so adding footage changes nothing"
 * silently assumed the footage was LIGHT: a white scrim under dark text. The
 * session-22 loop is near-black with thin bright lines, and the hero became dark
 * with light text — so the colour layer had to be rebuilt, not re-used. The
 * planner below never changed; what changed was a property of the media that no
 * string in this file expresses: which way round its brightness runs.
 *
 * So whoever swaps the footage next does ONE thing before anything else: check
 * whether the new material's light/dark direction matches the scrim in
 * `HeroBackdrop`. Same direction, it really is a file drop — rerun
 * `npm run qa:capture:landing` and read the numbers. Opposite direction, it is
 * a redesign of the colour layer, however small the diff looks.
 *
 * Dark footage, measured across the whole loop at frame resolution rather than
 * five evenly spaced frames: headline 7.21:1 and standfirst 6.23:1 at their
 * worst frames — where a bright line crosses the text — and 1.08:1 for the
 * headline with the scrim removed.
 *
 * `HeroBackdrop` owns the stacking order internally, so the video CANNOT end up
 * above the scrim: there is no JSX for a caller to get wrong. See rule 1j — the
 * guarantee belongs to the component, not to whoever edits the page next.
 */

export type HeroMedia = {
  /** A path under public/, spelled with exact case. Null means no footage. */
  src: string | null;
  /**
   * e.g. "/hero/poster.jpg". Used as the video's own poster AND as the static
   * image for a viewer who has asked for reduced motion. Null today.
   */
  poster: string | null;
};

/** The one thing a future session edits. Nothing else. */
export const HERO_MEDIA: HeroMedia = {
  src: "/videos/hero-video.mp4",
  poster: null,
};

export type HeroBackdropPlan =
  | { kind: "video"; src: string; poster: string | null }
  | { kind: "poster"; poster: string }
  | { kind: "none"; reason: "no_source" | "reduced_motion_no_poster" };

/**
 * What the backdrop should paint, decided before any DOM exists.
 *
 * Pure so the reduced-motion contract is a test rather than a claim: a viewer
 * who asks for reduced motion must never be handed a looping video, and the
 * page must still look deliberate when they are not.
 */
export function planHeroBackdrop(
  media: HeroMedia,
  options: { reducedMotion: boolean },
): HeroBackdropPlan {
  if (options.reducedMotion) {
    // A still frame is the honest reduced-motion fallback — same image, no
    // movement. With no poster there is nothing to show but the static layer,
    // which is a complete design on its own rather than a placeholder.
    return media.poster
      ? { kind: "poster", poster: media.poster }
      : { kind: "none", reason: "reduced_motion_no_poster" };
  }

  if (!media.src) {
    // A poster without a video is just an image, and the hero does not need
    // one: the gradient layer is the design today. Showing the poster alone
    // would make the page look like it is waiting for something.
    return { kind: "none", reason: "no_source" };
  }

  return { kind: "video", src: media.src, poster: media.poster };
}

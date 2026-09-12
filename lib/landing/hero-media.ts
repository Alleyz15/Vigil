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
 * headline for weeks is one whose contrast is already known. Today it grades
 * white-over-white and is invisible, which is exactly the point — it is already
 * doing its job, and putting footage underneath changes nothing about the text
 * on top of it.
 *
 * `HeroBackdrop` owns the stacking order internally, so the video CANNOT end up
 * above the scrim: there is no JSX for a caller to get wrong. See rule 1j — the
 * guarantee belongs to the component, not to whoever edits the page next.
 */

export type HeroMedia = {
  /** e.g. "/hero/loop.mp4". Null until the footage exists. */
  src: string | null;
  /**
   * e.g. "/hero/poster.jpg". Used as the video's own poster AND as the static
   * image for a viewer who has asked for reduced motion. Null today.
   */
  poster: string | null;
};

/** The one thing a future session edits. Nothing else. */
export const HERO_MEDIA: HeroMedia = {
  src: null,
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

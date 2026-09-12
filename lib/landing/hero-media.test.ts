import { describe, expect, it } from "vitest";
import { HERO_MEDIA, planHeroBackdrop, type HeroMedia } from "./hero-media";

const withVideo: HeroMedia = { src: "/hero/loop.mp4", poster: "/hero/poster.jpg" };

describe("the hero backdrop is reserved before the media exists", () => {
  it("paints nothing but the static layer while there is no source", () => {
    expect(planHeroBackdrop(HERO_MEDIA, { reducedMotion: false })).toEqual({
      kind: "none",
      reason: "no_source",
    });
  });

  /**
   * The whole point of the slot. Adding footage must be two strings and no
   * other edit — if this test needed changing to accept a video, the slot was
   * not actually reserved.
   */
  it("plays the video the moment a source is supplied, with no other change", () => {
    expect(planHeroBackdrop(withVideo, { reducedMotion: false })).toEqual({
      kind: "video",
      src: "/hero/loop.mp4",
      poster: "/hero/poster.jpg",
    });
  });

  it("carries a video that has no poster rather than refusing to play it", () => {
    expect(planHeroBackdrop({ src: "/hero/loop.mp4", poster: null }, { reducedMotion: false })).toEqual(
      { kind: "video", src: "/hero/loop.mp4", poster: null },
    );
  });

  /**
   * THE CONTRACT THAT MATTERS MOST, asserted now so it cannot be forgotten in
   * the session that finally adds the file. A viewer who has asked their
   * operating system for less motion must never be handed a looping video.
   */
  it("never hands a looping video to a viewer who asked for reduced motion", () => {
    const plan = planHeroBackdrop(withVideo, { reducedMotion: true });

    expect(plan.kind).not.toBe("video");
    expect(plan).toEqual({ kind: "poster", poster: "/hero/poster.jpg" });
  });

  it("falls back to the static layer when reduced motion leaves no still to show", () => {
    expect(planHeroBackdrop({ src: "/hero/loop.mp4", poster: null }, { reducedMotion: true })).toEqual({
      kind: "none",
      reason: "reduced_motion_no_poster",
    });
  });

  /**
   * A poster with no video would make the hero look like it is waiting for
   * something. The gradient layer is a finished design, not a placeholder.
   */
  it("does not show a poster as a substitute for a video that does not exist", () => {
    expect(planHeroBackdrop({ src: null, poster: "/hero/poster.jpg" }, { reducedMotion: false })).toEqual(
      { kind: "none", reason: "no_source" },
    );
  });

  it("ships with the slot empty", () => {
    expect(HERO_MEDIA).toEqual({ src: null, poster: null });
  });
});

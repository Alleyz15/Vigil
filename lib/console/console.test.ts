import { describe, expect, it } from "vitest";
import { loadScatter, loadScenario } from "./dataset";
import {
  type PlaybackState,
  initialPlayback,
  playbackReducer,
  shouldTick,
  tickIntervalMs,
} from "./playback";

/**
 * The console's read model and its playback machine.
 *
 * Component tests are lower value here than in the pure trees, so these target
 * the two things that would actually break silently: what the routes serve, and
 * the stepping logic the demo depends on.
 */

/* -------------------------------------------------------------------------- */
/* The playback machine, tested without React                                 */
/* -------------------------------------------------------------------------- */

describe("timeline playback", () => {
  const start = (legs = 6) => initialPlayback(legs);
  const run = (state: PlaybackState, ...actions: Parameters<typeof playbackReducer>[1][]) =>
    actions.reduce(playbackReducer, state);

  it("starts revealing nothing", () => {
    expect(start()).toEqual({ revealed: 0, status: "idle", cursor: null, legCount: 6 });
  });

  it("reveals one leg per tick while playing", () => {
    const state = run(start(), { type: "play" }, { type: "tick" }, { type: "tick" });
    expect(state.revealed).toBe(2);
    expect(state.cursor).toBe(1);
    expect(state.status).toBe("playing");
  });

  it("ignores ticks that arrive while paused", () => {
    const state = run(start(), { type: "play" }, { type: "tick" }, { type: "pause" }, { type: "tick" });
    expect(state.revealed).toBe(1);
    expect(state.status).toBe("paused");
  });

  it("finishes on the last leg rather than running past it", () => {
    let state = run(start(3), { type: "play" });
    for (let i = 0; i < 10; i++) state = playbackReducer(state, { type: "tick" });

    expect(state.revealed).toBe(3);
    expect(state.cursor).toBe(2);
    expect(state.status).toBe("done");
    expect(shouldTick(state)).toBe(false);
  });

  it("replays from the start when play is pressed at the end", () => {
    const finished = run(start(3), { type: "revealAll" });
    const replaying = playbackReducer(finished, { type: "play" });

    expect(replaying.revealed).toBe(1);
    expect(replaying.status).toBe("playing");
  });

  it("hands control to the viewer when they step by hand", () => {
    const state = run(start(), { type: "play" }, { type: "tick" }, { type: "next" });
    expect(state.status).toBe("paused");
    expect(state.revealed).toBe(2);
  });

  /**
   * Stepping back moves the cursor without un-revealing. Hiding evidence a
   * viewer has already seen is disorienting in a way that hiding evidence they
   * have not seen is not.
   */
  it("does not un-reveal when stepping back", () => {
    const state = run(start(), { type: "revealAll" }, { type: "prev" }, { type: "prev" });
    expect(state.revealed).toBe(6);
    expect(state.cursor).toBe(3);
  });

  it("clamps seek to the available legs", () => {
    expect(playbackReducer(start(4), { type: "seek", index: 99 }).cursor).toBe(3);
    expect(playbackReducer(start(4), { type: "seek", index: -5 }).cursor).toBe(0);
  });

  it("reveals up to the sought leg so a deep link shows the context before it", () => {
    const state = playbackReducer(start(6), { type: "seek", index: 4 });
    expect(state.revealed).toBe(5);
    expect(state.cursor).toBe(4);
  });

  it("resets to nothing revealed", () => {
    const state = run(start(), { type: "revealAll" }, { type: "reset" });
    expect(state).toEqual(initialPlayback(6));
  });

  it("reloads for a different scenario length", () => {
    const state = run(start(6), { type: "revealAll" }, { type: "load", legCount: 40 });
    expect(state).toEqual(initialPlayback(40));
  });

  it("holds longer on the exception than on an ordinary leg", () => {
    const atException: PlaybackState = { revealed: 6, status: "playing", cursor: 5, legCount: 6 };
    const elsewhere: PlaybackState = { revealed: 3, status: "playing", cursor: 2, legCount: 6 };

    expect(tickIntervalMs(atException, 5)).toBeGreaterThan(tickIntervalMs(elsewhere, 5));
  });

  it("accelerates a long timeline so forty legs are watchable", () => {
    const long: PlaybackState = { revealed: 5, status: "playing", cursor: 4, legCount: 40 };
    const short: PlaybackState = { revealed: 2, status: "playing", cursor: 1, legCount: 6 };

    expect(tickIntervalMs(long, null)).toBeLessThan(tickIntervalMs(short, null));
  });
});

/* -------------------------------------------------------------------------- */
/* The read model                                                             */
/* -------------------------------------------------------------------------- */

describe("the shipment read model", () => {
  it("serves S0 as accepted at every leg, with no operator troubled", async () => {
    const { view } = await loadScenario("S0");

    expect(view.legs).toHaveLength(6);
    expect(view.legs.map((l) => l.decision)).toEqual(Array(6).fill("accept"));
    expect(view.legs.every((l) => l.neededCosign === false)).toBe(true);
    expect(view.ledger.chainValid).toBe(true);
  });

  it("carries both axis scores as separate fields", async () => {
    const { view } = await loadScenario("S2");
    const last = view.legs[view.legs.length - 1];

    expect(last.inconsistencyScore).toBe(0);
    expect(last.patternScore).toBeGreaterThanOrEqual(40);
    // There is no combined field for a view to reach for.
    expect(last).not.toHaveProperty("totalScore");
  });

  it("carries the coverage line and the flags with their evidence", async () => {
    const { view } = await loadScenario("S1");
    const last = view.legs[view.legs.length - 1];

    expect(last.coverageLine).toMatch(/of 14 checks evaluable$/);
    const flag = last.flags.find((f) => f.id === "I7");
    expect(flag?.label).toBeTruthy();
    expect(flag?.evidence.length).toBeGreaterThan(0);
    expect(flag?.evidence[0]).toHaveProperty("field");
    expect(flag?.evidence[0]).toHaveProperty("value");
  });

  it("marks the exception leg so a view can distinguish it", async () => {
    const clean = await loadScenario("S0");
    const spoofed = await loadScenario("S1");

    expect(clean.view.exceptionLegIndex).toBeNull();
    expect(spoofed.view.exceptionLegIndex).toBe(5);
  });

  it("reports S3's abort record, because a failed forgery is evidence", async () => {
    const { view } = await loadScenario("S3");
    expect(view.ledger.aborts).toBeGreaterThan(0);
    expect(view.ledger.chainValid).toBe(true);
  });

  it("is memoised, so a second read does not re-run the agent", async () => {
    const first = await loadScenario("S0");
    const second = await loadScenario("S0");
    expect(second).toBe(first);
  });
});

/* -------------------------------------------------------------------------- */
/* The scatter dataset                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A score of null means the axis COULD NOT BE EVALUATED. It does not mean zero,
 * and the difference has to survive the trip to the browser — otherwise the
 * chart plots an unmeasured event at the origin and claims a measurement
 * nobody made. See CLAUDE.md.
 */
describe("the scatter dataset distinguishes not_evaluated from zero", () => {
  it("uses null for an unevaluated axis, never 0", async () => {
    const points = await loadScatter();
    const unevaluated = points.filter(
      (p) => p.inconsistencyScore === null || p.patternScore === null,
    );

    expect(unevaluated.length).toBeGreaterThan(0);
    for (const point of unevaluated) {
      if (point.inconsistencyScore === null) {
        expect(point.inconsistencyUnknownReason).toBeTruthy();
      }
      if (point.patternScore === null) {
        expect(point.patternUnknownReason).toBeTruthy();
      }
    }
  });

  it("gives a reason specific enough to act on", async () => {
    const points = await loadScatter();
    const reasons = points
      .flatMap((p) => [p.inconsistencyUnknownReason, p.patternUnknownReason])
      .filter((r): r is string => Boolean(r));

    // "We could not evaluate this" is weaker than saying why.
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(reason.length).toBeGreaterThan(20);
  });

  it("never carries a reason alongside a real score", async () => {
    const points = await loadScatter();

    for (const point of points) {
      if (point.inconsistencyScore !== null) expect(point.inconsistencyUnknownReason).toBeNull();
      if (point.patternScore !== null) expect(point.patternUnknownReason).toBeNull();
    }
  });

  it("covers every scenario", async () => {
    const points = await loadScatter();
    const scenarios = new Set(points.map((p) => p.scenarioId));

    expect(scenarios.size).toBe(7);
    expect(points.length).toBeGreaterThan(50);
  });
});

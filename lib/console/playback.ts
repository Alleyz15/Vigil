/**
 * The timeline's play-through.
 *
 * A pure reducer, deliberately outside React. This is the demo's spine — a
 * viewer watches a shipment go from ordinary to the exception rather than
 * arriving at the end state — and a spine that can only be exercised by
 * clicking a button in a browser is a spine nobody checks.
 *
 * No timers here either: `tick` is an action the caller sends. The component
 * owns the interval, this owns what a tick MEANS.
 */

export type PlaybackStatus = "idle" | "playing" | "paused" | "done";
export type PlaybackSpeed = 0.75 | 1 | 1.5;

export type PlaybackState = {
  /** How many legs are revealed. 0 = none yet, legCount = all of them. */
  revealed: number;
  status: PlaybackStatus;
  /** The leg the viewer is looking at, or null before playback starts. */
  cursor: number | null;
  legCount: number;
};

export type PlaybackAction =
  | { type: "play" }
  | { type: "pause" }
  | { type: "tick" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "reset" }
  /** Jump straight to a leg, e.g. from a deep link or the exception shortcut. */
  | { type: "seek"; index: number }
  /** Reveal everything at once, for someone who has seen the demo already. */
  | { type: "revealAll" }
  | { type: "load"; legCount: number };

export function initialPlayback(legCount: number): PlaybackState {
  return { revealed: 0, status: "idle", cursor: null, legCount };
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case "load":
      return initialPlayback(action.legCount);

    case "play":
      // Playing from the end restarts, rather than sitting on "done" doing
      // nothing — pressing play should always play something.
      if (state.revealed >= state.legCount) {
        return { ...state, revealed: 1, cursor: 0, status: "playing" };
      }
      // The control must feel immediate. Waiting a full reading interval before
      // showing leg one makes a working demo look stalled.
      if (state.revealed === 0 && state.legCount > 0) {
        return { ...state, revealed: 1, cursor: 0, status: "playing" };
      }
      return { ...state, status: "playing" };

    case "pause":
      return state.status === "playing" ? { ...state, status: "paused" } : state;

    case "tick": {
      if (state.status !== "playing") return state;
      const revealed = state.revealed + 1;
      if (revealed >= state.legCount) {
        return { ...state, revealed: state.legCount, cursor: state.legCount - 1, status: "done" };
      }
      return { ...state, revealed, cursor: revealed - 1 };
    }

    case "next": {
      // Stepping by hand takes over from playback: a viewer who reaches for the
      // controls has stopped watching and started driving.
      const revealed = clamp(state.revealed + 1, 1, state.legCount);
      return {
        ...state,
        revealed,
        cursor: revealed - 1,
        status: revealed >= state.legCount ? "done" : "paused",
      };
    }

    case "prev": {
      // Stepping back does not un-reveal: the legs already shown stay shown, and
      // only the cursor moves. Hiding evidence a viewer has already seen is
      // disorienting in a way that hiding evidence they have not seen is not.
      const cursor = clamp((state.cursor ?? 0) - 1, 0, state.legCount - 1);
      return { ...state, cursor, status: "paused" };
    }

    case "seek": {
      const index = clamp(action.index, 0, state.legCount - 1);
      return {
        ...state,
        cursor: index,
        revealed: Math.max(state.revealed, index + 1),
        status: index + 1 >= state.legCount ? "done" : "paused",
      };
    }

    case "revealAll":
      return {
        ...state,
        revealed: state.legCount,
        cursor: state.legCount - 1,
        status: "done",
      };

    case "reset":
      return initialPlayback(state.legCount);
  }
}

/** Whether the caller's interval should still be running. */
export function shouldTick(state: PlaybackState): boolean {
  return state.status === "playing" && state.revealed < state.legCount;
}

/**
 * How long to hold on a leg before advancing.
 *
 * S2 has forty legs and would take a minute at a readable pace, so long
 * timelines accelerate. The exception leg holds longer than the rest — it is
 * the thing the viewer is here to see, and a pace that treats it like any other
 * leg makes the whole play-through pointless.
 */
export function tickIntervalMs(
  state: PlaybackState,
  exceptionIndex: number | null,
  speed: PlaybackSpeed = 1,
): number {
  const atException = state.cursor !== null && state.cursor === exceptionIndex;
  const baseMs = atException
    ? 3_400
    : state.legCount > 20
      ? 420
      : state.legCount > 10
        ? 850
        : 1_900;

  return Math.round(baseMs / speed);
}

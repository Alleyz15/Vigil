/**
 * ONE REQUEST AT A TIME, AT MOST ONE PER SECOND, FOR THE WHOLE APPLICATION.
 *
 * Nominatim's usage policy sets an absolute maximum of one request per second,
 * and it is a limit on the APPLICATION, not on each user. So there is exactly
 * one queue per process (see `runtime.ts`), shared by search and reverse, and
 * it enforces two things together:
 *
 *   serial    a task starts only after the previous one has FINISHED
 *   spaced    a task starts at least `minIntervalMs` after the previous STARTED
 *
 * Serial alone would allow a burst of fast answers; spacing alone would allow
 * overlapping slow ones. Both together mean no two requests are ever in flight
 * and no two start within the interval, whatever the callers do.
 *
 * A BOUNDED BACKLOG. With `maxPending` tasks already waiting, a new one is
 * refused IMMEDIATELY with `QueueSaturated` rather than queued behind them — a
 * person should be told "too many lookups" now, not left watching a spinner for
 * thirty seconds while their request waits its turn. Refusal is not a request,
 * so it costs the upstream nothing.
 *
 * The clock and the sleep are injected so the spacing can be tested as a
 * measurement rather than a promise.
 */

export class QueueSaturated extends Error {
  constructor(pending: number) {
    super(`${pending} geocoding requests are already waiting`);
    this.name = "QueueSaturated";
  }
}

export type SerialQueue = {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks waiting or running. For tests and diagnostics. */
  pending(): number;
};

export function createSerialQueue(options: {
  minIntervalMs: number;
  maxPending: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): SerialQueue {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let tail: Promise<unknown> = Promise.resolve();
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let waiting = 0;

  return {
    pending: () => waiting,
    run<T>(task: () => Promise<T>): Promise<T> {
      if (waiting >= options.maxPending) return Promise.reject(new QueueSaturated(waiting));
      waiting += 1;

      const turn = tail.then(async () => {
        const wait = lastStartedAt + options.minIntervalMs - now();
        if (wait > 0) await sleep(wait);
        lastStartedAt = now();
        try {
          return await task();
        } finally {
          waiting -= 1;
        }
      });
      // The chain must survive a failed task: the next caller waits for this
      // one to END, not to succeed.
      tail = turn.catch(() => undefined);
      return turn;
    },
  };
}

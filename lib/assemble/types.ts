/**
 * The caller layer: turns database state into the inputs the pure modules take.
 *
 * THIS IS WHERE I/O LIVES, and it is deliberately NOT under lib/purity.test.ts.
 * lib/engine, lib/pattern and lib/gate do arithmetic on what they are handed;
 * everything that reaches for a row happens here. That separation is what makes
 * "the verdict is a pure function of its inputs" checkable rather than hopeful.
 */

/**
 * What an assembler could and could not resolve.
 *
 * Absence must stay VISIBLE. A region with no reference sites on file and a
 * region we simply failed to query look identical in an `undefined` — so the
 * assembler says which, and the rules downstream report `not_evaluated` rather
 * than being handed a fabricated default.
 *
 * This is also the single source for the operator's evidence-coverage line.
 * See `coverageLine()`.
 */
export type Resolution = {
  /** Things that were found and used. */
  resolved: string[];
  /** Things that were looked for and were not there, each with a reason. */
  missing: { what: string; reason: string }[];
};

export const emptyResolution = (): Resolution => ({ resolved: [], missing: [] });

export function resolved(resolution: Resolution, what: string): void {
  resolution.resolved.push(what);
}

export function missing(resolution: Resolution, what: string, reason: string): void {
  resolution.missing.push({ what, reason });
}

/** Merge assembler resolutions, so one run reports one picture. */
export function mergeResolutions(...parts: Resolution[]): Resolution {
  return {
    resolved: parts.flatMap((p) => p.resolved),
    missing: parts.flatMap((p) => p.missing),
  };
}

/** An assembled input, together with the story of how it was assembled. */
export type Assembled<T> = {
  input: T;
  resolution: Resolution;
};

/**
 * The operator's evidence-coverage line — "8 of 14 checks evaluable".
 *
 * Computed from the rule coverage the engines report, which is in turn driven
 * by what the assembler could resolve. ONE source, not two: a second count
 * derived independently would drift from the first, and the operator would be
 * shown a number that no longer describes the decision in front of them.
 */
export function coverageLine(coverage: { evaluated: number; total: number }): string {
  return `${coverage.evaluated} of ${coverage.total} checks evaluable`;
}

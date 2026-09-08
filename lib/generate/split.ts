/**
 * Deterministic holdout.
 *
 * WHY IT EXISTS. Thresholds tuned on the same data they are reported against
 * measure how well they were tuned, not how well they work. Experiment 5 in the
 * plan calls for blinding: build the set, split it, tune on one half, report on
 * the other. The split has to be reproducible or the report is not checkable.
 *
 * The split is a pure function of the item's own key, not of its position or of
 * a shuffle, so adding a scenario to the set does not reassign the ones already
 * placed.
 */

/** FNV-1a over the key. Small, deterministic, and adequate for a coin flip. */
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export type Split = "tune" | "report";

/** Which half an item falls in. */
export function splitOf(key: string, seed: string, tuneFraction = 0.5): Split {
  const bucket = (hashKey(`${seed}::${key}`) % 10_000) / 10_000;
  return bucket < tuneFraction ? "tune" : "report";
}

/** Partition a set of keyed items. */
export function partition<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  seed: string,
  tuneFraction = 0.5,
): { tune: T[]; report: T[] } {
  const tune: T[] = [];
  const report: T[] = [];
  for (const item of items) {
    (splitOf(keyOf(item), seed, tuneFraction) === "tune" ? tune : report).push(item);
  }
  return { tune, report };
}

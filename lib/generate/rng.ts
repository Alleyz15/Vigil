import seedrandom from "seedrandom";

/**
 * Seeded randomness. Every number the generator uses comes from here.
 *
 * REPRODUCIBILITY IS THE POINT. `Math.random()` anywhere in lib/generate would
 * make a dataset that cannot be regenerated, which makes an experiment run on
 * it unrepeatable and therefore worthless as evidence. A test asserts that the
 * same seed produces byte-identical output.
 */
export type Rng = {
  /** Uniform in [0, 1). */
  next: () => number;
  /** Integer in [min, max], inclusive. */
  int: (min: number, max: number) => number;
  /** Uniform in [min, max). */
  float: (min: number, max: number) => number;
  /** One element. Throws on an empty list rather than returning undefined. */
  pick: <T>(items: readonly T[]) => T;
  /** A new array, shuffled. The input is left alone. */
  shuffle: <T>(items: readonly T[]) => T[];
  /** True with the given probability. */
  chance: (probability: number) => boolean;
  /**
   * A child generator, deterministically derived from this one's seed.
   * Lets one scenario draw without shifting what another scenario draws.
   */
  derive: (label: string) => Rng;
};

export function makeRng(seed: string): Rng {
  const random = seedrandom(seed);

  const next = () => random();
  const float = (min: number, max: number) => min + next() * (max - min);
  const int = (min: number, max: number) => Math.floor(float(min, max + 1));

  return {
    next,
    float,
    int,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error("cannot pick from an empty list");
      return items[int(0, items.length - 1)];
    },
    shuffle: <T>(items: readonly T[]): T[] => {
      const copy = [...items];
      // Fisher-Yates, drawing from the seeded stream.
      for (let i = copy.length - 1; i > 0; i--) {
        const j = int(0, i);
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
    chance: (probability: number) => next() < probability,
    derive: (label: string) => makeRng(`${seed}::${label}`),
  };
}

/** Metres to degrees of latitude. Good enough at Klang Valley latitudes. */
export const METRES_PER_DEGREE_LAT = 111_320;

/** Offset a point by a distance in metres. */
export function offsetPoint(
  point: { latitude: number; longitude: number },
  metresNorth: number,
  metresEast: number,
): { latitude: number; longitude: number } {
  const latitude = point.latitude + metresNorth / METRES_PER_DEGREE_LAT;
  const longitude =
    point.longitude +
    metresEast / (METRES_PER_DEGREE_LAT * Math.cos((point.latitude * Math.PI) / 180));
  return { latitude, longitude };
}

/** A point jittered within `radiusMetres`, for scatter around an address. */
export function jitterPoint(
  rng: Rng,
  point: { latitude: number; longitude: number },
  radiusMetres: number,
): { latitude: number; longitude: number } {
  const angle = rng.float(0, Math.PI * 2);
  const distance = Math.sqrt(rng.next()) * radiusMetres;
  return offsetPoint(point, Math.sin(angle) * distance, Math.cos(angle) * distance);
}

/** ISO-8601 with the Malaysian offset the fixtures use throughout. */
export const MY_OFFSET = "+08:00";

/** Format an epoch millisecond value as ISO-8601 at +08:00. */
export function isoAt(ms: number): string {
  const shifted = new Date(ms + 8 * 3_600_000);
  return `${shifted.toISOString().slice(0, 19)}${MY_OFFSET}`;
}

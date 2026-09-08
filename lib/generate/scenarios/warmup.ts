import type { BuiltEvent } from "../timeline";
import { buildLegEvent } from "../timeline";
import type { Rng } from "../rng";
import type { GeneratedCourier, GeneratedParcel, GeneratedWorld } from "../world";

/**
 * Ordinary prior work, so a courier is not judged cold.
 *
 * WHY THIS EXISTS. The pattern axis reports `coldStart` below ten handoffs in
 * the window, and only counts events that already carry a sealed verdict.
 * Without warm-up, EVERY scenario — including S0 — lands in the cold-start
 * co-sign path, and S0 cannot demonstrate the thing it exists to demonstrate:
 * that ordinary work is accepted cleanly, without an operator being troubled.
 *
 * These are plain delivery scans at a human pace, spread across the address
 * set. They are the courier's normal, and the pattern rules are measuring a
 * departure from it.
 */
export function buildWarmup(args: {
  world: GeneratedWorld;
  courier: GeneratedCourier;
  parcels: GeneratedParcel[];
  rng: Rng;
  /** When the warm-up round starts, in epoch ms. */
  startMs: number;
  count?: number;
  idPrefix: string;
  /** Minutes between deliveries. A real round is not a burst. */
  intervalMinutes?: number;
}): BuiltEvent[] {
  const {
    world,
    courier,
    parcels,
    rng,
    startMs,
    count = 14,
    idPrefix,
    intervalMinutes = 17,
  } = args;

  const deliveryLeg = {
    name: "delivery" as const,
    bizStep: "urn:epcglobal:cbv:bizstep:delivering",
    disposition: "urn:epcglobal:cbv:disp:retail_sold",
    offsetMinutes: 0,
    where: "recipient" as const,
  };

  return parcels.slice(0, count).map((parcel, index) => {
    const legRng = rng.derive(`${idPrefix}-warmup-${index}`);
    // A human pace, with the jitter a real round has.
    const at = startMs + (index * intervalMinutes + legRng.int(-4, 4)) * 60_000;

    return buildLegEvent({
      world,
      courier,
      parcel,
      leg: deliveryLeg,
      legIndex: index,
      startMs: at,
      rng: legRng,
      eventIdSeed: `${idPrefix}-warmup-${index}`,
    });
  });
}

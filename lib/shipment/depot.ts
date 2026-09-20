import { distanceMeters } from "@/lib/engine/geo";
import { DEPOTS, type Depot } from "@/lib/generate/route";

/**
 * Which depot serves an arbitrary coordinate.
 *
 * THE DEPOTS ARE THE EXISTING THREE, UNCHANGED. `lib/generate/route.ts` derives
 * them from the cached address set and they are not re-derived here: an online
 * shipment is routed through the same facilities as every built and seeded one,
 * so a point typed on a map does not quietly get a network of its own.
 *
 * NEAREST BY GREAT-CIRCLE DISTANCE, ties broken by the depots' fixed order. A
 * tie is vanishingly unlikely on real coordinates; the rule exists so the answer
 * is a function of the point and never of iteration order or floating-point
 * luck in some other runtime.
 *
 * `distanceMeters` is imported from `lib/engine/geo` for the reason `route.ts`
 * gives: it is arithmetic about the world, not a threshold, and two haversines
 * could disagree about the same two points.
 */

export type Point = { latitude: number; longitude: number };

export function depotFor(point: Point, depots: readonly Depot[] = DEPOTS): Depot {
  let nearest = depots[0];
  let best = Infinity;
  for (const depot of depots) {
    const metres = distanceMeters(point, depot);
    // Strictly less: on an exact tie the earlier depot in DEPOTS keeps it.
    if (metres < best) {
      best = metres;
      nearest = depot;
    }
  }
  return nearest;
}

export type DepotRoute = {
  originDepot: Depot;
  destinationDepot: Depot;
  /**
   * Both ends are served by one depot.
   *
   * A LOCAL DELIVERY, SAID PLAINLY. The route is not sent via another depot to
   * manufacture a line-haul: a local parcel labelled local is more honest than a
   * fabricated short haul — the same reason k=3 was chosen over k=5.
   */
  local: boolean;
  /** Zero when local. Never a detour. */
  lineHaulMetres: number;
  lastMileMetres: number;
};

export function routeBetween(origin: Point, destination: Point): DepotRoute {
  const originDepot = depotFor(origin);
  const destinationDepot = depotFor(destination);
  const local = originDepot.addressIndex === destinationDepot.addressIndex;
  return {
    originDepot,
    destinationDepot,
    local,
    lineHaulMetres: local ? 0 : distanceMeters(originDepot, destinationDepot),
    lastMileMetres: distanceMeters(destinationDepot, destination),
  };
}

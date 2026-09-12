import { distanceMeters } from "@/lib/engine/geo";
import { ADDRESSES, type Address } from "./world";
import { NORMAL_LEGS, type LegSpec } from "./timeline";

/**
 * Routes built from an arbitrary origin/destination pair.
 *
 * The scenario builder lets a viewer pick two of the cached addresses and runs
 * a real shipment between them. That needs three things the seeded scenarios
 * got for free, because they were written against one fixed lane:
 *
 *   1. WHICH depots the parcel passes through
 *   2. HOW LONG each moving leg takes
 *   3. Whether the route is long enough to have a line-haul at all
 *
 * WHY `distanceMeters` IS IMPORTED FROM `lib/engine/geo`. The anti-circularity
 * guard bans the generator from reading a detector THRESHOLD, and from the
 * `@/lib/engine` barrel because it re-exports them. A haversine is neither — it
 * is arithmetic about the world, and writing a second one here would mean two
 * distance functions that can disagree about the same two points. One
 * implementation, per rule 5's reasoning about `canonicalize`.
 */

export type Depot = {
  label: string;
  latitude: number;
  longitude: number;
  /** Index into ADDRESSES, so reference sites resolve without a lookup by label. */
  addressIndex: number;
};

/**
 * Depots, derived from the cached address set rather than hardcoded.
 *
 * WHAT THIS IS AND IS NOT. Declaring "a depot is sited at this coordinate" is a
 * world-model assertion, which is exactly what `lib/generate` exists to make —
 * the generator emits behaviour and facts about the world. It is NOT the same
 * as inventing a coordinate for a point nobody geocoded: every depot below sits
 * on a real Nominatim-resolved location from the committed address file, and
 * the selection rule is geography, not a list someone typed.
 *
 * The split is longitude-ordered thirds, each depot being the member nearest
 * its third's mean point. Deterministic, no randomness, and it moves if the
 * address file does — which is the property that makes it "derived" rather than
 * "hardcoded with extra steps".
 */
export const DEPOT_COUNT = 3;

export const DEPOTS: Depot[] = deriveDepots(ADDRESSES, DEPOT_COUNT);

function deriveDepots(addresses: Address[], count: number): Depot[] {
  const ordered = addresses
    .map((address, addressIndex) => ({ address, addressIndex }))
    .sort((a, b) => a.address.longitude - b.address.longitude);

  const depots: Depot[] = [];
  const size = Math.ceil(ordered.length / count);

  for (let bucket = 0; bucket < count; bucket++) {
    const members = ordered.slice(bucket * size, (bucket + 1) * size);
    if (members.length === 0) continue;

    const mean = {
      latitude: members.reduce((sum, m) => sum + m.address.latitude, 0) / members.length,
      longitude: members.reduce((sum, m) => sum + m.address.longitude, 0) / members.length,
    };

    let nearest = members[0];
    let best = Infinity;
    for (const member of members) {
      const metres = distanceMeters(pointOf(member.address), mean);
      if (metres < best) {
        best = metres;
        nearest = member;
      }
    }

    depots.push({
      label: `${nearest.address.label} depot`,
      latitude: nearest.address.latitude,
      longitude: nearest.address.longitude,
      addressIndex: nearest.addressIndex,
    });
  }

  return depots;
}

function pointOf(address: Address): { latitude: number; longitude: number } {
  return { latitude: address.latitude, longitude: address.longitude };
}

/**
 * Average door-to-door road speed, in km/h. AN ASSUMPTION.
 *
 * Malaysian limits are 110 km/h on expressways and 90 km/h on federal roads,
 * but a line-haul between depots is not a limit — it is a door-to-door average
 * including urban segments, traffic and the approach at each end. 45 km/h is
 * assumed for that average and is NOT a measured figure.
 *
 * IT WAS NOT CHOSEN WITH REFERENCE TO I3. Rule 2b: a parameter picked so its
 * worst case lands just under a detector's cut is `0%` written in a different
 * file. This number describes how fast a van moves; if a route it produces
 * makes I3 fire, that is reported as a finding and the number does not move to
 * make the demo tidy.
 */
export const ASSUMED_ROAD_SPEED_KMH = 45;

/**
 * The shortest a moving leg can take, in minutes. AN ASSUMPTION.
 *
 * Loading, paperwork and the walk to the door do not vanish because two points
 * are close together. Without a floor a same-depot route produces a zero
 * interval, and `impliedSpeed` returns undefined on one rather than an infinity
 * — honest, but it silently removes the leg from I3's reach.
 */
export const MIN_TRAVEL_MINUTES = 12;

export function travelMinutes(metres: number): number {
  const minutes = Math.round((metres / 1000 / ASSUMED_ROAD_SPEED_KMH) * 60);
  return Math.max(MIN_TRAVEL_MINUTES, minutes);
}

export type Route = {
  origin: Address;
  originIndex: number;
  destination: Address;
  destinationIndex: number;
  originHub: Depot;
  destinationHub: Depot;
  /**
   * Both ends resolve to one depot.
   *
   * A LOCAL SHIPMENT, said plainly rather than papered over. The line-haul legs
   * still happen — a parcel departs and arrives at the same facility all the
   * time — and the alternative, routing it via a depot it has no reason to
   * visit, would fabricate a detour to manufacture a leg.
   */
  local: boolean;
  lineHaulMetres: number;
  lastMileMetres: number;
  /** NORMAL_LEGS with the moving legs retimed for this route's distances. */
  legs: LegSpec[];
};

export function nearestDepot(address: Address): Depot {
  let nearest = DEPOTS[0];
  let best = Infinity;
  for (const depot of DEPOTS) {
    const metres = distanceMeters(pointOf(address), depot);
    if (metres < best) {
      best = metres;
      nearest = depot;
    }
  }
  return nearest;
}

/**
 * Resolve a route between two cached addresses.
 *
 * `recipientPoint` is the parcel's actual doorstep, which is jittered off the
 * geocoded centroid — the last-mile leg is timed against where the courier is
 * really going, not against the address label's coordinate.
 */
export function resolveRoute(args: {
  originIndex: number;
  destinationIndex: number;
  recipientPoint?: { latitude: number; longitude: number };
}): Route {
  const origin = ADDRESSES[args.originIndex];
  const destination = ADDRESSES[args.destinationIndex];
  if (!origin || !destination) {
    throw new Error(
      `route needs two cached addresses; got indices ${args.originIndex} and ${args.destinationIndex} ` +
        `against ${ADDRESSES.length} on file`,
    );
  }

  const originHub = nearestDepot(origin);
  const destinationHub = nearestDepot(destination);
  const local = originHub.addressIndex === destinationHub.addressIndex;

  const lineHaulMetres = distanceMeters(originHub, destinationHub);
  const lastMileMetres = distanceMeters(
    destinationHub,
    args.recipientPoint ?? pointOf(destination),
  );

  return {
    origin,
    originIndex: args.originIndex,
    destination,
    destinationIndex: args.destinationIndex,
    originHub,
    destinationHub,
    local,
    lineHaulMetres,
    lastMileMetres,
    legs: retime(lineHaulMetres, lastMileMetres),
  };
}

/**
 * Retime the two legs that involve movement, and leave the rest alone.
 *
 * Only two gaps in `NORMAL_LEGS` cover distance: departure→arrival, and out for
 * delivery→delivery. The others are dwell at one facility, and a depot does not
 * sort faster because the parcel has further to go.
 */
function retime(lineHaulMetres: number, lastMileMetres: number): LegSpec[] {
  const base = NORMAL_LEGS;
  const gapAfter = (name: string, fallback: number): number => {
    const index = base.findIndex((leg) => leg.name === name);
    return index >= 0 && index + 1 < base.length
      ? base[index + 1].offsetMinutes - base[index].offsetMinutes
      : fallback;
  };

  const out: LegSpec[] = [];
  let offset = 0;

  for (let i = 0; i < base.length; i++) {
    const leg = base[i];
    out.push({ ...leg, offsetMinutes: offset });

    const previous = base[i];
    const gap =
      previous.name === "linehaul_departure"
        ? travelMinutes(lineHaulMetres)
        : previous.name === "out_for_delivery"
          ? travelMinutes(lastMileMetres)
          : gapAfter(previous.name, 0);

    offset += gap;
  }

  return out;
}

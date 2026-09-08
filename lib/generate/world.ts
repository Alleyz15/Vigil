import type { GeoPoint } from "@/lib/epcis";
import type { CourierMandate } from "@/lib/mandate/schema";
import { generateKeyPair } from "@/lib/credential";
import addressData from "./data/kl-addresses.json";
import { type Rng, jitterPoint, makeRng, offsetPoint } from "./rng";

/**
 * The world a scenario happens in: addresses, hubs, couriers, mandates,
 * parcels, and the positioning sources I1 contradicts GPS against.
 *
 * NO NETWORK. Addresses come from a cached JSON file fetched once by
 * scripts/fetch-addresses.mjs. The file records its own provenance in a
 * `source` field, so data read from here is never of unknown origin.
 */

export type Address = {
  label: string;
  latitude: number;
  longitude: number;
  osmDisplayName?: string;
};

export const ADDRESS_SOURCE: string = addressData.source;
export const ADDRESSES: Address[] = addressData.addresses;

/** Sortation hubs. Placed on real depot-ish locations in the address set. */
export const HUBS = {
  kl: { label: "KL Central Hub", latitude: 3.1338, longitude: 101.6869 },
  shahAlam: { label: "Shah Alam Hub", latitude: 3.0733, longitude: 101.5185 },
} as const;

export type GeneratedCourier = {
  courierId: string;
  displayName: string;
  deviceId: string;
  keys: { publicKey: string; privateKey: string };
  mandate: CourierMandate;
};

export type GeneratedParcel = {
  epc: string;
  waybillNo: string;
  recipientName: string;
  recipientAddress: string;
  recipientPoint: GeoPoint;
  declaredValueSen: number;
  codAmountSen: number;
};

export type ReferenceSiteSeed = {
  siteId: string;
  kind: "cell" | "wifi";
  lat: number;
  lng: number;
  label: string;
  /** The address this site sits at, so a scan there can observe it. */
  nearAddressIndex: number;
};

export type GeneratedWorld = {
  seed: string;
  addressSource: string;
  couriers: GeneratedCourier[];
  parcels: GeneratedParcel[];
  referenceSites: ReferenceSiteSeed[];
  /** Cell/WiFi ids observable at each address index. */
  sitesByAddress: { cell: string; wifi: string }[];
};

/** EPC prefixes, one per courier, so H2's scope check has something to bite on. */
const EPC_PREFIX = "urn:epc:id:sgtin:0614141.";

export function epcFor(prefixIndex: number, serial: number): string {
  return `${EPC_PREFIX}${String(100000 + prefixIndex).padStart(6, "0")}.${serial}`;
}

export function prefixFor(prefixIndex: number): string {
  return `${EPC_PREFIX}${String(100000 + prefixIndex).padStart(6, "0")}.`;
}

const FIRST_NAMES = [
  "Nurul", "Aiman", "Siti", "Faiz", "Mei Ling", "Rajesh", "Hafiz", "Wei Jie",
  "Kavitha", "Zulkifli", "Anis", "Daniel", "Priya", "Syafiq", "Yee Ling", "Arif",
];
const LAST_NAMES = [
  "binti Abdullah", "Tan", "a/p Muthu", "bin Ismail", "Lim", "Chen", "Krishnan", "Wong",
];

/**
 * Cell towers and WiFi APs positioned on the address set.
 *
 * WITHOUT THESE, I1 IS PERMANENTLY not_evaluated and S1 cannot be demonstrated
 * at all — there is nothing for a spoofed GPS fix to contradict. A cell is
 * placed within macro range of each address; a WiFi AP sits at the building.
 */
function buildReferenceSites(rng: Rng, addresses: Address[]) {
  const referenceSites: ReferenceSiteSeed[] = [];
  const sitesByAddress: { cell: string; wifi: string }[] = [];

  addresses.forEach((address, index) => {
    // A macro cell a few hundred metres off, as a real serving cell would be.
    const cellPoint = jitterPoint(rng, address, 600);
    const cellId = `502-12-${4500 + index}-${90000 + index}`;
    referenceSites.push({
      siteId: cellId,
      kind: "cell",
      lat: cellPoint.latitude,
      lng: cellPoint.longitude,
      label: `Cell near ${address.label}`,
      nearAddressIndex: index,
    });

    // An access point in the building itself.
    const wifiPoint = jitterPoint(rng, address, 25);
    const bssid = macFor(index);
    referenceSites.push({
      siteId: bssid,
      kind: "wifi",
      lat: wifiPoint.latitude,
      lng: wifiPoint.longitude,
      label: `AP at ${address.label}`,
      nearAddressIndex: index,
    });

    sitesByAddress.push({ cell: cellId, wifi: bssid });
  });

  return { referenceSites, sitesByAddress };
}

function macFor(index: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `a4:2b:8c:00:${hex(Math.floor(index / 256))}:${hex(index % 256)}`;
}

export type WorldOptions = {
  courierCount?: number;
  /** Parcels per courier, across warm-up history and scenarios. */
  parcelsPerCourier?: number;
};

/**
 * Build a world from a seed.
 *
 * A FLEET, not a single courier. P2 compares a courier's dispute rate against
 * the queue baseline, and a baseline computed from one courier is that courier
 * — the comparison would be vacuous.
 */
export function buildWorld(seed: string, options: WorldOptions = {}): GeneratedWorld {
  const { courierCount = 4, parcelsPerCourier = 60 } = options;
  const rng = makeRng(`${seed}::world`);

  const { referenceSites, sitesByAddress } = buildReferenceSites(
    rng.derive("sites"),
    ADDRESSES,
  );

  const couriers: GeneratedCourier[] = [];
  const parcels: GeneratedParcel[] = [];

  for (let c = 0; c < courierCount; c++) {
    const courierId = `CR-${String(1000 + c)}`;
    const nameRng = rng.derive(`courier-${c}`);

    couriers.push({
      courierId,
      displayName: `${nameRng.pick(FIRST_NAMES)} ${nameRng.pick(LAST_NAMES)}`,
      deviceId: `HHT-${String(1000 + c)}`,
      keys: generateKeyPair(),
      mandate: buildMandate(courierId, c),
    });

    for (let p = 0; p < parcelsPerCourier; p++) {
      const parcelRng = rng.derive(`parcel-${c}-${p}`);
      const addressIndex = parcelRng.int(0, ADDRESSES.length - 1);
      const address = ADDRESSES[addressIndex];
      // The doorstep is not the geocoded centroid; scatter within the block.
      const point = jitterPoint(parcelRng, address, 60);

      parcels.push({
        epc: epcFor(c, p),
        waybillNo: `WB-2026-${String(c)}${String(p).padStart(5, "0")}`,
        recipientName: `${parcelRng.pick(FIRST_NAMES)} ${parcelRng.pick(LAST_NAMES)}`,
        recipientAddress: address.label,
        recipientPoint: point,
        declaredValueSen: parcelRng.int(1_500, 45_000),
        codAmountSen: parcelRng.chance(0.25) ? parcelRng.int(1_000, 18_000) : 0,
      });
    }
  }

  return { seed, addressSource: ADDRESS_SOURCE, couriers, parcels, referenceSites, sitesByAddress };
}

/**
 * A courier's mandate.
 *
 * Scoped to that courier's EPC prefix, so S4 (a scan outside scope) is a real
 * H2 failure rather than a contrived one. Co-sign conditions are realistic:
 * a high-value parcel or an already-inconsistent handoff needs a human.
 */
function buildMandate(courierId: string, index: number): CourierMandate {
  return {
    mandateId: `MD-${String(1000 + index)}`,
    courierId,
    preset: "standard",
    scope: {
      epcPrefixes: [prefixFor(index)],
      bizLocations: [],
      bizSteps: [],
    },
    limits: {
      maxHandoffsPerShift: 120,
      codCashCapSen: 20_000,
      maxParcelValueSen: 100_000,
    },
    validity: {
      notBefore: "2026-09-01T00:00:00+08:00",
      notAfter: "2026-12-31T23:59:59+08:00",
      timeWindows: [],
    },
    requiresCosignIf: [
      { kind: "parcel_value_over_sen", value: 40_000 },
      { kind: "inconsistency_score_at_least", value: 30 },
    ],
    cooldownSeconds: 0,
    status: "active",
    nonceCounter: 0,
  };
}

/** The address a parcel is addressed to, and its index in the address set. */
export function addressIndexFor(parcel: GeneratedParcel): number {
  const found = ADDRESSES.findIndex((a) => a.label === parcel.recipientAddress);
  return found === -1 ? 0 : found;
}

export { jitterPoint, offsetPoint };

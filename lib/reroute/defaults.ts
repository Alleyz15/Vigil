import type { PickupPoint } from "./types";

/**
 * Prototype pickup points, held as operational reference data rather than
 * generated scenario evidence. They never move with a seed and never call a
 * network service.
 */
export const DEFAULT_PICKUP_POINTS: PickupPoint[] = [
  {
    pickupPointId: "PP-KL-SENTRAL",
    label: "KL Sentral collection point",
    bizLocation: "urn:epc:id:sgln:0614141.00991.0",
    latitude: 3.1343,
    longitude: 101.6861,
    active: true,
  },
  {
    pickupPointId: "PP-BUKIT-BINTANG",
    label: "Bukit Bintang collection point",
    bizLocation: "urn:epc:id:sgln:0614141.00992.0",
    latitude: 3.1468,
    longitude: 101.7113,
    active: true,
  },
  {
    pickupPointId: "PP-PETALING-JAYA",
    label: "Petaling Jaya collection point",
    bizLocation: "urn:epc:id:sgln:0614141.00993.0",
    latitude: 3.1073,
    longitude: 101.6067,
    active: true,
  },
];


import type { LegOverrides } from "./timeline";

/**
 * How much trouble the fraudster goes to.
 *
 * The attacker-cost experiment sweeps this into a curve rather than reporting a
 * single number: "we catch fraud" is not a finding, "here is how far a
 * fraudster gets for each capability they acquire" is.
 *
 * BEHAVIOUR, NOT STATISTICS. Each level describes a CAPABILITY the attacker
 * has — a mock-location app, a rooted handset, a patched build, a colluding
 * recipient. It does not describe which detector it defeats, and this module
 * must not import a threshold from lib/engine or lib/pattern. A generator tuned
 * against the detector proves only that it was tuned. See CLAUDE.md.
 */
export const CAREFULNESS_LEVELS = [0, 1, 2, 3, 4] as const;
export type Carefulness = (typeof CAREFULNESS_LEVELS)[number];

export type CarefulnessProfile = {
  level: Carefulness;
  /** What the attacker had to obtain to operate at this level. */
  capability: string;
  /** Whether the handset still reports a mock location provider. */
  reportsMockProvider: boolean;
  /** Whether the device attestation still fails. */
  attestationFails: boolean;
  /** Whether the cell and WiFi observations are made consistent with the lie. */
  fakesRadioEnvironment: boolean;
  /** Whether the accelerometer trace is made consistent with the claimed travel. */
  fakesMotion: boolean;
  /** Whether battery drain is made consistent with the claimed distance. */
  fakesBattery: boolean;
  /** Whether the recipient is in on it and therefore never complains. */
  recipientColludes: boolean;
};

export const CAREFULNESS: Record<Carefulness, CarefulnessProfile> = {
  0: {
    level: 0,
    capability: "A mock-location app from the app store.",
    reportsMockProvider: true,
    attestationFails: false,
    fakesRadioEnvironment: false,
    fakesMotion: false,
    fakesBattery: false,
    recipientColludes: false,
  },
  1: {
    level: 1,
    capability: "A rooted handset, so the OS stops reporting the mock provider.",
    reportsMockProvider: false,
    attestationFails: true,
    fakesRadioEnvironment: false,
    fakesMotion: false,
    fakesBattery: false,
    recipientColludes: false,
  },
  2: {
    level: 2,
    capability: "A patched build that passes attestation and forges the radio environment.",
    reportsMockProvider: false,
    attestationFails: false,
    fakesRadioEnvironment: true,
    fakesMotion: false,
    fakesBattery: false,
    recipientColludes: false,
  },
  3: {
    level: 3,
    capability: "The above, plus a synthesised accelerometer trace and battery curve.",
    reportsMockProvider: false,
    attestationFails: false,
    fakesRadioEnvironment: true,
    fakesMotion: true,
    fakesBattery: true,
    recipientColludes: false,
  },
  4: {
    level: 4,
    capability: "The above, plus a recipient who agrees not to complain.",
    reportsMockProvider: false,
    attestationFails: false,
    fakesRadioEnvironment: true,
    fakesMotion: true,
    fakesBattery: true,
    recipientColludes: true,
  },
};

/**
 * Turn a profile into the signal overrides a forged scan would carry.
 *
 * At every level the courier is claiming to be somewhere they are not; what
 * changes is how much of the surrounding evidence they manage to make agree.
 */
export function forgedScanOverrides(
  profile: CarefulnessProfile,
  claimed: { latitude: number; longitude: number },
  consistentSites: { cell: string; wifi: string },
  elsewhereSites: { cell: string; wifi: string },
): LegOverrides {
  return {
    scanPoint: claimed,
    mockLocation: profile.reportsMockProvider,
    integrityFailed: profile.attestationFails,
    // An attacker who cannot forge the radio environment still reports the cell
    // they are ACTUALLY connected to, which is nowhere near where they claim.
    cellSiteId: profile.fakesRadioEnvironment ? consistentSites.cell : elsewhereSites.cell,
    wifiBssid: profile.fakesRadioEnvironment ? consistentSites.wifi : elsewhereSites.wifi,
    motionStationary: !profile.fakesMotion,
  };
}

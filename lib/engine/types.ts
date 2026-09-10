import type {
  DeviceRecognitionVerdict,
  EpcisEvent,
  GeoPoint,
  VigilSignals,
} from "@/lib/epcis";
import type { BizStep, Disposition } from "@/lib/epcis";
import type { CourierMandate } from "@/lib/mandate/schema";
import type { Thresholds } from "./thresholds";

/**
 * Axis 1 of the orthogonal gate: single-event inconsistency.
 *
 * Everything in this module is PURE. No rule reads a file, opens a socket, or
 * touches the database — the caller assembles EngineInput and the rules do
 * arithmetic on it. That is what makes "delete the LLM and the verdicts are
 * byte-identical" a mechanical property rather than a claim, and there is a test
 * (engine.purity.test.ts) that asserts it by inspecting the module imports.
 */

/** One field-and-value pair that contributed to a flag. */
export type Evidence = {
  /** Dotted path naming where the value came from, e.g. "sensor.gps.point". */
  field: string;
  value: unknown;
};

/** A scored contradiction, with the evidence that produced it. */
export type Flag = {
  /** "H1".."H3" for hard checks, "I1".."I16" for inconsistency scores. */
  id: string;
  points: number;
  /** Plain language, for an operator. No jargon, no field names. */
  label: string;
  evidence: Evidence[];
};

/**
 * The three states a rule can end in.
 *
 * `not_evaluated` is NOT a synonym for `clear`. A signal that never arrived tells
 * us nothing, and scoring it as clean would make S6 (a tunnel: GPS degraded,
 * signals missing) indistinguishable from S1 (spoofing: GPS present and lying).
 * Those two scenarios are the whole false-positive argument. See CLAUDE.md.
 */
export type RuleResult =
  | { status: "triggered"; flag: Flag }
  | { status: "clear" }
  | { status: "not_evaluated"; reason: string };

/** Hard checks abort; they do not score. */
export type HardResult = { status: "pass" } | { status: "fail"; flag: Flag };

/** A positioning source whose real-world location we know independently of GPS. */
export type ReferenceSite = {
  /** Identifier as observed, e.g. a cell id or a BSSID. */
  id: string;
  point: GeoPoint;
};

/** What the previous event in this parcel's timeline told us. */
export type PreviousEvent = {
  eventTime: string;
  disposition?: Disposition;
  bizStep?: BizStep;
  /** Where the previous scan happened, if known. */
  point?: GeoPoint;
  /** Battery level at the previous scan, for I14. */
  batteryPercent?: number;
};

/** Server-side record of one independently delivered OTP challenge. */
export type OtpChallengeEvidence = {
  challengeId: string;
  epc: string;
  recipientChannelFingerprint: string;
  deliveryStatus: "delivered" | "failed" | "unknown";
  verificationReceiptId?: string | null;
  issuedAt: string;
  expiresAt: string;
  verifiedAt?: string | null;
  consumedByEventId?: string | null;
};

/** Server-side enrollment policy for the handset that authored this event. */
export type DeviceEnrollmentEvidence = {
  deviceId: string;
  requiredRecognitionVerdict: DeviceRecognitionVerdict;
};

/**
 * Everything the engine needs, assembled by the caller.
 *
 * `previous` and `referenceSites` are explicitly optional. Their absence is a
 * first-class, tested path: I1, I2, I3 and I14 must report `not_evaluated`
 * rather than `clear` when the data they depend on is not there. S6 exercises
 * exactly that path, so it is real behaviour, not an incidental fallback.
 */
export type EngineInput = {
  /** The validated event. `recordTime` must already be stamped by the caller. */
  event: EpcisEvent;
  /** The vigil: signal bundle, if the event carried one. */
  sensor?: VigilSignals;

  /** Resolved courier record. Absent means lookup did not find one. */
  courier?: { courierId: string; boundDeviceId?: string | null };
  /** Resolved mandate. Absent means the courier has no active mandate. */
  mandate?: CourierMandate;
  /** Resolved parcel, incl. where it was actually supposed to go. */
  parcel?: {
    epc: string;
    recipientPoint?: GeoPoint;
    /** One-way fingerprint of the registered out-of-band recipient channel. */
    recipientChannelFingerprint?: string;
  };

  /** Independently recorded OTP verifier transaction. Optional by design. */
  otpChallenge?: OtpChallengeEvidence;
  /** Enrollment for the observed device id. Optional by design. */
  deviceEnrollment?: DeviceEnrollmentEvidence;

  /** The preceding event for this parcel. Optional; absence is tested. */
  previous?: PreviousEvent;

  /** Known locations for independently-positioned observations. Optional. */
  referenceSites?: {
    /** Location of the serving cell reported in `sensor.cell`. */
    cell?: ReferenceSite;
    /** Locations of any observed WiFi APs we recognise, keyed by BSSID. */
    wifi?: ReferenceSite[];
  };

  thresholds: Thresholds;
};

/** What the engine returns for one event. Axis 1 only. */
export type EngineResult = {
  /** True when any hard check failed. No partial accept. */
  aborted: boolean;
  /** Set when aborted, naming the first failing hard check in H1..H3 order. */
  abortCode?: string;
  /** Every hard check that failed. All three are evaluated before aborting. */
  hardFailures: Flag[];

  /** Inconsistency flags. Empty when aborted: a hard failure suppresses scoring. */
  flags: Flag[];
  /** Sum of flag points before clamping. Kept for threshold sweeps. */
  rawScore: number;
  /** rawScore clamped to thresholds.scoreCap. This is axis 1. */
  score: number;

  /**
   * Which rules could actually be evaluated. Rendered for the operator as
   * "12 of 16 checks evaluable", so a low score on thin evidence is visibly
   * different from a low score on complete evidence.
   */
  coverage: {
    evaluated: number;
    total: number;
    notEvaluated: { id: string; reason: string }[];
  };
};

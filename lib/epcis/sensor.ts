import { z } from "zod";
import { GeoPoint, Iso8601WithOffset } from "./primitives";

/**
 * The `how` dimension: EPCIS 2.0 `sensorElementList`, plus Vigil's own signals.
 *
 * WHY THE EXTENSION EXISTS
 * ------------------------
 * Mock-location flags, cell-tower observations, WiFi scans and device integrity
 * attestations are not in the GS1 Core Business Vocabulary — no standard sensor
 * type covers them. EPCIS 2.0 explicitly provides for user extensions carried on
 * a vendor namespace, so they live under the `vigil:` prefix rather than being
 * smuggled into standard fields or bolted onto a parallel non-standard envelope.
 *
 * Every field below is a *signal*, never a *judgement*. Nothing here says
 * "fraudulent"; the deterministic engine decides that by finding contradictions
 * ACROSS these fields. A single signal is always forgeable — that premise is the
 * whole reason this project exists.
 */

/** Standard GS1 sensor report entry. Kept for cold-chain-shaped signals. */
export const SensorReport = z.strictObject({
  type: z
    .string()
    .regex(/^[a-zA-Z][\w-]*:[\w-]+$/, "must be a CURIE, e.g. gs1:Temperature"),
  value: z.number().optional(),
  stringValue: z.string().optional(),
  booleanValue: z.boolean().optional(),
  uom: z.string().optional(),
  time: Iso8601WithOffset.optional(),
});
export type SensorReport = z.infer<typeof SensorReport>;

/**
 * GPS fix as reported by the handset.
 * `mockLocationProvider` is what Android's location API tells us; a rooted
 * device can lie about it, which is exactly why it is only ever ONE input.
 */
export const VigilGpsFix = z.strictObject({
  point: GeoPoint,
  /** Device-local time of the fix. Compared against eventTime and recordTime. */
  fixTime: Iso8601WithOffset,
  speedMps: z.number().nonnegative().optional(),
  /** Android's isFromMockProvider(), or the iOS equivalent. Feeds I7. */
  mockLocationProvider: z.boolean(),
  satelliteCount: z.number().int().nonnegative().optional(),
});
export type VigilGpsFix = z.infer<typeof VigilGpsFix>;

/**
 * Serving cell at the moment of the scan. Independent of GPS, and much harder
 * to forge coherently, because the tower's real location is not the courier's
 * to choose. Contradiction with the GPS fix feeds I1.
 */
export const VigilCellObservation = z.strictObject({
  mcc: z.number().int().min(0).max(999),
  mnc: z.number().int().min(0).max(999),
  /** Location/tracking area code. */
  lac: z.number().int().nonnegative(),
  cellId: z.number().int().nonnegative(),
  signalDbm: z.number().optional(),
});
export type VigilCellObservation = z.infer<typeof VigilCellObservation>;

/** Visible WiFi APs. A third independent positioning channel; also feeds I1. */
export const VigilWifiObservation = z.strictObject({
  bssid: z.string().regex(/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/, "must be a MAC address"),
  rssiDbm: z.number(),
});
export type VigilWifiObservation = z.infer<typeof VigilWifiObservation>;

/**
 * Accelerometer summary over the window preceding the scan.
 * A device that claims to have travelled while reading dead-still is the I2
 * contradiction. We store a summary, not a raw trace: the engine needs a
 * statistic, and shipping raw traces would be a privacy liability.
 */
export const VigilMotionSummary = z.strictObject({
  windowSeconds: z.number().positive(),
  /** Mean magnitude of (|a| - g), in m/s^2. Near zero means physically still. */
  meanAbsDeviationMs2: z.number().nonnegative(),
  maxAbsDeviationMs2: z.number().nonnegative(),
  /** Device's own step counter delta over the window, if available. */
  stepCountDelta: z.number().int().nonnegative().optional(),
});
export type VigilMotionSummary = z.infer<typeof VigilMotionSummary>;

/**
 * Play Integrity's documented device-recognition labels, preserved verbatim.
 *
 * The prototype uses `mocked` attestations, but the mocked payload must still
 * say which real provider semantics it is standing in for. An invented label
 * would make the synthetic evidence impossible to interpret or reproduce.
 */
export const DeviceRecognitionVerdict = z.enum([
  "MEETS_BASIC_INTEGRITY",
  "MEETS_DEVICE_INTEGRITY",
  "MEETS_STRONG_INTEGRITY",
]);
export type DeviceRecognitionVerdict = z.infer<typeof DeviceRecognitionVerdict>;

/**
 * Stand-in for Play Integrity / DeviceCheck.
 *
 * MOCKED FOR THE PROTOTYPE — `attestationSource` is required and must say so.
 * We refuse to let a simulated attestation be indistinguishable from a real one
 * in our own data, because that would be exactly the forgery we claim to detect.
 */
export const VigilDeviceIntegrity = z.strictObject({
  attestationSource: z.enum(["mocked", "play-integrity", "device-check"]),
  /** Overall verdict the attestation service returned. Feeds I8. */
  verdict: z.enum(["passed", "failed", "unevaluated"]),
  rootDetected: z.boolean(),
  appTampered: z.boolean(),
  /** Exact Play Integrity labels, when the provider supplied that dimension. */
  deviceRecognitionVerdicts: z.array(DeviceRecognitionVerdict).max(3).optional(),
  /** Opaque token echoed for the audit trail; not parsed by the engine. */
  attestationToken: z.string().optional(),
});
export type VigilDeviceIntegrity = z.infer<typeof VigilDeviceIntegrity>;

/** Battery reading. Movement costs energy; a flat curve under a long claimed route feeds I14. */
export const VigilBattery = z.strictObject({
  levelPercent: z.number().min(0).max(100),
  charging: z.boolean(),
});
export type VigilBattery = z.infer<typeof VigilBattery>;

/**
 * References the server-side result of an out-of-band OTP challenge.
 *
 * Neither the OTP nor a reusable digest of it belongs in EPCIS. The event
 * carries opaque identifiers; I15 resolves them against the independently
 * recorded verifier transaction assembled by the caller.
 */
export const VigilOtpReceipt = z.strictObject({
  challengeId: z.uuid(),
  verificationReceiptId: z.uuid(),
});
export type VigilOtpReceipt = z.infer<typeof VigilOtpReceipt>;

/**
 * Proof-of-delivery artefacts. Presence/absence feeds I12; the photo's EXIF
 * capture time versus the event time feeds I9.
 *
 * We store hashes, not images. The prototype never needs the pixels, and a
 * hash is the part that is actually evidentially useful.
 */
export const VigilPodEvidence = z.strictObject({
  photoSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** EXIF DateTimeOriginal, if the photo carried one. */
  photoExifCaptureTime: Iso8601WithOffset.optional(),
  otpVerified: z.boolean().optional(),
  /** Independent-channel provenance for the OTP claim. */
  otp: VigilOtpReceipt.optional(),
  signatureSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type VigilPodEvidence = z.infer<typeof VigilPodEvidence>;

/**
 * The full Vigil signal bundle. Every member is optional: a real handset drops
 * signals constantly (no cell service, GPS denied indoors), and a MISSING signal
 * must never be scored the same as a CONTRADICTORY one. That distinction is the
 * difference between S1 (spoofing) and S6 (a tunnel), which is a demo beat.
 */
export const VigilSignals = z.strictObject({
  /** Hardware identifier of the scanning device. Checked against the courier binding for I6. */
  deviceId: z.string().min(1).optional(),
  gps: VigilGpsFix.optional(),
  cell: VigilCellObservation.optional(),
  wifi: z.array(VigilWifiObservation).max(64).optional(),
  motion: VigilMotionSummary.optional(),
  integrity: VigilDeviceIntegrity.optional(),
  battery: VigilBattery.optional(),
  pod: VigilPodEvidence.optional(),
});
export type VigilSignals = z.infer<typeof VigilSignals>;

/** EPCIS `sensorMetadata` — context shared by every report in the element. */
export const SensorMetadata = z.strictObject({
  time: Iso8601WithOffset.optional(),
  deviceID: z.string().optional(),
  deviceMetadata: z.string().optional(),
  rawData: z.string().optional(),
});
export type SensorMetadata = z.infer<typeof SensorMetadata>;

/**
 * One `sensorElementList` entry. The `vigil:signals` key is the namespaced
 * extension described at the top of this file.
 */
export const SensorElement = z.strictObject({
  sensorMetadata: SensorMetadata.optional(),
  sensorReport: z.array(SensorReport).optional(),
  "vigil:signals": VigilSignals.optional(),
});
export type SensorElement = z.infer<typeof SensorElement>;

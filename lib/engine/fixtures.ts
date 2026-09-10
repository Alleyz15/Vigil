import { EpcisEvent } from "@/lib/epcis";
import type { GeoPoint } from "@/lib/epcis";
import type { CourierMandate } from "@/lib/mandate/schema";
import { DEFAULT_THRESHOLDS } from "./thresholds";
import type { EngineInput } from "./types";

/**
 * Shared test fixtures. Not imported by any rule — only by tests.
 *
 * Coordinates are real Kuala Lumpur / Selangor locations so a distance that
 * reads as "2 km" in a test is 2 km on the ground, and a reviewer can check one.
 */

/** Jalan Ampang, KL — the recipient address in most fixtures. */
export const KL_AMPANG: GeoPoint = { latitude: 3.1595, longitude: 101.7123 };
/** ~230 m from KL_AMPANG. Trips I11 but not I10. */
export const KL_AMPANG_NEXT_BLOCK: GeoPoint = { latitude: 3.1616, longitude: 101.7123 };
/** ~150 m from KL_AMPANG. Under the I11 band. */
export const KL_AMPANG_DOORSTEP: GeoPoint = { latitude: 3.1608, longitude: 101.7123 };
/** Shah Alam, ~24 km west. Trips I10. */
export const SHAH_ALAM: GeoPoint = { latitude: 3.0733, longitude: 101.5185 };
/** Ipoh, ~180 km north. For impossible-speed fixtures. */
export const IPOH: GeoPoint = { latitude: 4.5975, longitude: 101.0901 };

export const EPC = "urn:epc:id:sgtin:0614141.107346.2017";
export const COURIER_ID = "CR-0042";
export const DEVICE_ID = "HHT-0042";
export const EVENT_ID = "6f8c0d3e-4a1b-4c2d-9e5f-2b7a1c3d4e5f";
export const OTP_CHALLENGE_ID = "4be4cb19-a04a-4e93-8e9a-287108ae68e2";
export const OTP_RECEIPT_ID = "5c59c087-bf4c-48ae-a0d2-cb68e3de021d";

/**
 * A delivery-step event. `recordTime` is stamped, as the caller would have done.
 *
 * Built THROUGH the schema rather than cast to it, so every fixture is a
 * genuinely valid EPCIS event. A fixture that only type-asserts its way past
 * validation would let the engine be tested against data the ingest boundary
 * would have rejected.
 */
export function makeEvent(over: Record<string, unknown> = {}): EpcisEvent {
  return EpcisEvent.parse({
    type: "ObjectEvent",
    eventID: EVENT_ID,
    eventTime: "2026-09-08T10:15:00+08:00",
    recordTime: "2026-09-08T10:15:30+08:00",
    eventTimeZoneOffset: "+08:00",
    epcList: [EPC],
    action: "OBSERVE",
    bizStep: "urn:epcglobal:cbv:bizstep:delivering",
    disposition: "urn:epcglobal:cbv:disp:in_progress",
    "vigil:courierId": COURIER_ID,
    ...over,
  });
}

export function makeMandate(over: Partial<CourierMandate> = {}): CourierMandate {
  return {
    mandateId: "MD-0001",
    courierId: COURIER_ID,
    preset: "standard",
    scope: {
      epcPrefixes: ["urn:epc:id:sgtin:0614141.107346."],
      bizLocations: [],
      bizSteps: [],
    },
    limits: { maxHandoffsPerShift: 60, codCashCapSen: 20_000, maxParcelValueSen: 100_000 },
    validity: {
      notBefore: "2026-09-01T00:00:00+08:00",
      notAfter: "2026-12-31T23:59:59+08:00",
      timeWindows: [],
    },
    requiresCosignIf: [],
    cooldownSeconds: 0,
    status: "active",
    nonceCounter: 0,
    ...over,
  };
}

/**
 * A clean baseline input: every rule that can be evaluated returns clear.
 * Tests perturb exactly one thing from here, so a failure names its own cause.
 */
export function makeInput(over: Partial<EngineInput> = {}): EngineInput {
  return {
    event: makeEvent(),
    sensor: {
      deviceId: DEVICE_ID,
      gps: {
        point: { ...KL_AMPANG_DOORSTEP, accuracyMeters: 8 },
        fixTime: "2026-09-08T10:15:00+08:00",
        speedMps: 0,
        mockLocationProvider: false,
      },
      motion: { windowSeconds: 60, meanAbsDeviationMs2: 0.4, maxAbsDeviationMs2: 1.2 },
      integrity: {
        attestationSource: "mocked",
        verdict: "passed",
        rootDetected: false,
        appTampered: false,
        deviceRecognitionVerdicts: ["MEETS_DEVICE_INTEGRITY"],
      },
      battery: { levelPercent: 61, charging: false },
      pod: {
        photoSha256: "a".repeat(64),
        photoExifCaptureTime: "2026-09-08T10:14:30+08:00",
        otpVerified: true,
        otp: {
          challengeId: OTP_CHALLENGE_ID,
          verificationReceiptId: OTP_RECEIPT_ID,
        },
        signatureSha256: "b".repeat(64),
      },
    },
    courier: { courierId: COURIER_ID, boundDeviceId: DEVICE_ID },
    deviceEnrollment: {
      deviceId: DEVICE_ID,
      requiredRecognitionVerdict: "MEETS_DEVICE_INTEGRITY",
    },
    mandate: makeMandate(),
    parcel: {
      epc: EPC,
      recipientPoint: KL_AMPANG,
      recipientChannelFingerprint: "sha256:registered-recipient",
    },
    otpChallenge: {
      challengeId: OTP_CHALLENGE_ID,
      epc: EPC,
      recipientChannelFingerprint: "sha256:registered-recipient",
      deliveryStatus: "delivered",
      verificationReceiptId: OTP_RECEIPT_ID,
      issuedAt: "2026-09-08T10:05:00+08:00",
      expiresAt: "2026-09-08T10:15:00+08:00",
      verifiedAt: "2026-09-08T10:12:00+08:00",
      consumedByEventId: EVENT_ID,
    },
    previous: {
      eventTime: "2026-09-08T09:45:00+08:00",
      disposition: "urn:epcglobal:cbv:disp:in_possession",
      bizStep: "urn:epcglobal:cbv:bizstep:transporting",
      point: KL_AMPANG_NEXT_BLOCK,
      batteryPercent: 68,
    },
    referenceSites: {
      cell: { id: "502-12-4501-90210", point: KL_AMPANG },
      wifi: [{ id: "a4:2b:8c:00:11:22", point: KL_AMPANG }],
    },
    thresholds: DEFAULT_THRESHOLDS,
    ...over,
  };
}

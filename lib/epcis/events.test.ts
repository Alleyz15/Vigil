import { describe, expect, it } from "vitest";
import { EpcisEvent, ObjectEvent, TransactionEvent, epcsOf, vigilSignalsOf } from "./events";
import { Iso8601WithOffset, UtcOffset } from "./primitives";
import { VigilSignals } from "./sensor";

const base = {
  type: "ObjectEvent" as const,
  eventID: "6f8c0d3e-4a1b-4c2d-9e5f-2b7a1c3d4e5f",
  eventTime: "2026-09-08T10:15:00+08:00",
  eventTimeZoneOffset: "+08:00",
  epcList: ["urn:epc:id:sgtin:0614141.107346.2017"],
  action: "OBSERVE" as const,
};

describe("timestamps", () => {
  it("requires an explicit offset, because eventTime vs recordTime is meaningless without one", () => {
    expect(Iso8601WithOffset.safeParse("2026-09-08T10:15:00").success).toBe(false);
    expect(Iso8601WithOffset.safeParse("2026-09-08T10:15:00Z").success).toBe(true);
    expect(Iso8601WithOffset.safeParse("2026-09-08T10:15:00+08:00").success).toBe(true);
  });

  it("rejects an offset outside -12:00..+14:00", () => {
    expect(UtcOffset.safeParse("+08:00").success).toBe(true);
    expect(UtcOffset.safeParse("+14:00").success).toBe(true);
    expect(UtcOffset.safeParse("+15:00").success).toBe(false);
    expect(UtcOffset.safeParse("-13:00").success).toBe(false);
  });

  it("accepts an event with no recordTime, since the server authors that field", () => {
    expect(ObjectEvent.safeParse(base).success).toBe(true);
  });

  it("models eventTime and recordTime as separate fields", () => {
    const parsed = ObjectEvent.parse({ ...base, recordTime: "2026-09-08T10:47:00+08:00" });
    expect(parsed.eventTime).not.toBe(parsed.recordTime);
  });
});

describe("the five dimensions", () => {
  it("carries what / when / where / why / how on one event", () => {
    const parsed = ObjectEvent.parse({
      ...base,
      readPoint: { id: "urn:epc:id:sgln:0614141.00777.0" },
      bizLocation: { id: "urn:epc:id:sgln:0614141.00888.0" },
      bizStep: "urn:epcglobal:cbv:bizstep:delivering",
      disposition: "urn:epcglobal:cbv:disp:in_progress",
      sensorElementList: [{ "vigil:signals": { deviceId: "HHT-0042" } }],
    });

    expect(parsed.epcList).toHaveLength(1);
    expect(parsed.eventTimeZoneOffset).toBe("+08:00");
    expect(parsed.readPoint?.id).toBeDefined();
    expect(parsed.bizStep).toBeDefined();
    expect(vigilSignalsOf(parsed)?.deviceId).toBe("HHT-0042");
  });

  it("rejects a bizStep that is not in the CBV", () => {
    expect(ObjectEvent.safeParse({ ...base, bizStep: "urn:epcglobal:cbv:bizstep:teleporting" }).success).toBe(false);
  });

  it("rejects unknown top-level keys rather than silently carrying them", () => {
    expect(ObjectEvent.safeParse({ ...base, totallyLegit: true }).success).toBe(false);
  });
});

describe("event types", () => {
  it("discriminates the three types", () => {
    expect(EpcisEvent.parse(base).type).toBe("ObjectEvent");
    expect(
      EpcisEvent.parse({
        type: "AssociationEvent",
        eventID: base.eventID,
        eventTime: base.eventTime,
        eventTimeZoneOffset: base.eventTimeZoneOffset,
        action: base.action,
        parentID: "HHT-0042",
        childEPCs: base.epcList,
      }).type,
    ).toBe("AssociationEvent");
  });

  it("will not let an AssociationEvent smuggle in an epcList", () => {
    const smuggled = {
      type: "AssociationEvent",
      eventID: base.eventID,
      eventTime: base.eventTime,
      eventTimeZoneOffset: base.eventTimeZoneOffset,
      action: base.action,
      parentID: "HHT-0042",
      epcList: base.epcList,
    };
    expect(EpcisEvent.safeParse(smuggled).success).toBe(false);
  });

  it("will not accept a TransactionEvent with no business transaction", () => {
    const handoff = { ...base, type: "TransactionEvent" as const, bizTransactionList: [] };
    expect(TransactionEvent.safeParse(handoff).success).toBe(false);

    const withTxn = {
      ...handoff,
      bizTransactionList: [{ type: "urn:epcglobal:cbv:btt:bol", bizTransaction: "WB-2026-000123" }],
    };
    expect(TransactionEvent.safeParse(withTxn).success).toBe(true);
  });

  it("reads EPCs from childEPCs on an AssociationEvent", () => {
    const assoc = EpcisEvent.parse({
      type: "AssociationEvent",
      eventID: base.eventID,
      eventTime: base.eventTime,
      eventTimeZoneOffset: base.eventTimeZoneOffset,
      action: "ADD",
      parentID: "HHT-0042",
      childEPCs: base.epcList,
    });
    expect(epcsOf(assoc)).toEqual(base.epcList);
  });

  it("rejects an empty ADD association because GS1 requires a child object", () => {
    expect(
      EpcisEvent.safeParse({
        type: "AssociationEvent",
        eventID: base.eventID,
        eventTime: base.eventTime,
        eventTimeZoneOffset: base.eventTimeZoneOffset,
        action: "ADD",
        parentID: "urn:epc:id:giai:0614141.12345",
        childEPCs: [],
      }).success,
    ).toBe(false);
  });

  it("allows an empty DELETE association to remove every child", () => {
    expect(
      EpcisEvent.safeParse({
        type: "AssociationEvent",
        eventID: base.eventID,
        eventTime: base.eventTime,
        eventTimeZoneOffset: base.eventTimeZoneOffset,
        action: "DELETE",
        parentID: "urn:epc:id:giai:0614141.12345",
        childEPCs: [],
      }).success,
    ).toBe(true);
  });
});

describe("the vigil: extension", () => {
  it("treats every signal as optional, so a missing signal is not a contradiction", () => {
    expect(VigilSignals.safeParse({}).success).toBe(true);
  });

  it("requires the attestation source to be named, so a mock cannot pass as real", () => {
    const missingSource = { integrity: { verdict: "passed", rootDetected: false, appTampered: false } };
    expect(VigilSignals.safeParse(missingSource).success).toBe(false);

    const declared = {
      integrity: {
        attestationSource: "mocked",
        verdict: "passed",
        rootDetected: false,
        appTampered: false,
      },
    };
    expect(VigilSignals.safeParse(declared).success).toBe(true);
  });

  it("carries the independent positioning channels the cross-signal checks compare", () => {
    const parsed = VigilSignals.parse({
      gps: {
        point: { latitude: 3.139, longitude: 101.6869 },
        fixTime: "2026-09-08T10:15:00+08:00",
        mockLocationProvider: false,
      },
      cell: { mcc: 502, mnc: 12, lac: 4501, cellId: 90210 },
      wifi: [{ bssid: "a4:2b:8c:00:11:22", rssiDbm: -61 }],
      motion: { windowSeconds: 60, meanAbsDeviationMs2: 0.02, maxAbsDeviationMs2: 0.05 },
    });

    expect(parsed.gps?.mockLocationProvider).toBe(false);
    expect(parsed.cell?.mcc).toBe(502);
    expect(parsed.wifi).toHaveLength(1);
  });

  it("models an OTP verification receipt without carrying the secret", () => {
    const parsed = VigilSignals.parse({
      pod: {
        otpVerified: true,
        otp: {
          challengeId: "4be4cb19-a04a-4e93-8e9a-287108ae68e2",
          verificationReceiptId: "5c59c087-bf4c-48ae-a0d2-cb68e3de021d",
        },
      },
    });

    expect(parsed.pod?.otp?.challengeId).toBe("4be4cb19-a04a-4e93-8e9a-287108ae68e2");
    expect(parsed.pod).not.toHaveProperty("otpCode");
  });

  it("accepts only documented Play Integrity recognition labels", () => {
    const baseIntegrity = {
      attestationSource: "mocked" as const,
      verdict: "passed" as const,
      rootDetected: false,
      appTampered: false,
    };

    expect(
      VigilSignals.safeParse({
        integrity: {
          ...baseIntegrity,
          deviceRecognitionVerdicts: ["MEETS_DEVICE_INTEGRITY"],
        },
      }).success,
    ).toBe(true);
    expect(
      VigilSignals.safeParse({
        integrity: {
          ...baseIntegrity,
          deviceRecognitionVerdicts: ["TRUST_ME_BRO"],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed MAC address", () => {
    expect(VigilSignals.safeParse({ wifi: [{ bssid: "not-a-mac", rssiDbm: -61 }] }).success).toBe(false);
  });
});

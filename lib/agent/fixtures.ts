import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMigratedDb } from "@/lib/db/migrate";
import { couriers, disputes, mandates, parcels, referenceSites } from "@/lib/db/schema";
import { NonceLedger } from "@/lib/ledger";
import { mandateToRow } from "@/lib/assemble";
import { makeMandate } from "@/lib/engine/fixtures";
import type { CourierMandate } from "@/lib/mandate/schema";
import type { GeoPoint } from "@/lib/epcis";
import { cosign, courierCredential, generateKeyPair } from "@/lib/credential";
import type { Credential } from "@/lib/credential";
import { EpcisEvent } from "@/lib/epcis";
import type { NodeDeps } from "./nodes";
import { runAgent as runAgentRef, type RunOptions } from "./machine";

/**
 * A seeded world for the agent tests: a real in-memory SQLite, a real ledger
 * file, and a clock the test controls. No mocks — the assemblers are the thing
 * under test, and a mocked row would prove nothing about a query.
 */

export const EPC = "urn:epc:id:sgtin:0614141.107346.2017";
export const COURIER_ID = "CR-0042";
export const DEVICE_ID = "HHT-0042";
export const CELL_ID = "502-12-4501-90210";
export const WIFI_BSSID = "a4:2b:8c:00:11:22";

export const KL_AMPANG: GeoPoint = { latitude: 3.1595, longitude: 101.7123 };
export const KL_AMPANG_DOORSTEP: GeoPoint = { latitude: 3.1608, longitude: 101.7123 };
export const KL_HUB: GeoPoint = { latitude: 3.1319, longitude: 101.6841 };
export const SHAH_ALAM: GeoPoint = { latitude: 3.0733, longitude: 101.5185 };

export type World = {
  deps: NodeDeps;
  dir: string;
  /** Advance the injected clock, so durations and orderings are testable. */
  tick: (ms?: number) => void;
  /** The keypairs this world was seeded with. Generated per world, never committed. */
  keys: { courier: KeyPair; operator: KeyPair; impostor: KeyPair };
  /**
   * Build the credential a device would present with this event.
   *
   * A SIDECAR: it is returned separately and passed to runAgent as an option,
   * never merged into the event. See CLAUDE.md.
   */
  credentialFor: (event: unknown, options?: CredentialOptions) => Credential;
};

type KeyPair = { publicKey: string; privateKey: string };

export type CredentialOptions = {
  /** Add a valid operator co-signature. */
  cosign?: boolean;
  /** Sign the courier half with the wrong key. */
  forgeCourier?: boolean;
  /** Co-sign with a key that is not the configured operator's. */
  forgeOperator?: boolean;
  nonce?: string;
};

export type SeedOptions = {
  withCourier?: boolean;
  withParcel?: boolean;
  withMandate?: boolean;
  /** Register the cell/WiFi sites the fixtures observe. Off => I1 not_evaluated. */
  withReferenceSites?: boolean;
  mandate?: Partial<CourierMandate>;
  /** Where the parcel is addressed. Omit to leave the parcel without coordinates. */
  recipientPoint?: GeoPoint | null;
  startAt?: string;
};

export function seedWorld(options: SeedOptions = {}): World {
  const {
    withCourier = true,
    withParcel = true,
    withMandate = true,
    withReferenceSites = true,
    recipientPoint = KL_AMPANG,
    // 30 seconds after the fixture eventTime (10:15:00+08:00 == 02:15:00Z).
    // The server clock must sit in the same frame as the device clock, or every
    // fixture event trips I4/I5 for a timezone mistake in the test harness.
    startAt = "2026-09-08T02:15:30.000Z",
  } = options;

  const dir = mkdtempSync(join(tmpdir(), "vigil-agent-"));
  const db = createMigratedDb(":memory:");

  // Fresh keypairs per world. Nothing is committed and no env var is read.
  const keys = {
    courier: generateKeyPair(),
    operator: generateKeyPair(),
    impostor: generateKeyPair(),
  };

  if (withParcel) {
    db.insert(parcels)
      .values({
        epc: EPC,
        waybillNo: "WB-2026-000123",
        recipientName: "Nurul",
        recipientAddress: "Jalan Ampang, Kuala Lumpur",
        recipientLat: recipientPoint?.latitude ?? null,
        recipientLng: recipientPoint?.longitude ?? null,
        declaredValueSen: 12_000,
        codAmountSen: 0,
      })
      .run();
  }

  if (withCourier) {
    db.insert(couriers)
      .values({
        courierId: COURIER_ID,
        displayName: "Courier 42",
        publicKey: keys.courier.publicKey,
        boundDeviceId: DEVICE_ID,
      })
      .run();
  }

  if (withCourier && withMandate) {
    db.insert(mandates)
      .values(mandateToRow(makeMandate({ courierId: COURIER_ID, ...options.mandate })))
      .run();
  }

  if (withReferenceSites) {
    db.insert(referenceSites)
      .values([
        { siteId: CELL_ID, kind: "cell", lat: KL_AMPANG.latitude, lng: KL_AMPANG.longitude, label: "Ampang macro" },
        { siteId: WIFI_BSSID, kind: "wifi", lat: KL_AMPANG.latitude, lng: KL_AMPANG.longitude, label: "Lobby AP" },
      ])
      .run();
  }

  let clock = Date.parse(startAt);

  const credentialFor = (event: unknown, options: CredentialOptions = {}): Credential => {
    // Some tests deliberately submit an unparsable event to exercise the parse
    // failure. Those runs halt long before the gate, so the credential is never
    // checked - build a well-formed one from whatever fields are readable
    // rather than throwing inside the fixture.
    const parsed = EpcisEvent.safeParse(event).data;
    const raw = (event ?? {}) as Record<string, unknown>;
    const subject = {
      v: 1 as const,
      eventID: parsed?.eventID ?? (raw.eventID as string) ?? eventId(0),
      epc:
        (parsed && (parsed.type === "AssociationEvent" ? (parsed.childEPCs ?? [])[0] : parsed.epcList[0])) ??
        ((raw.epcList as string[] | undefined)?.[0] ?? EPC),
      courierId: (parsed?.["vigil:courierId"] ?? (raw["vigil:courierId"] as string)) ?? COURIER_ID,
      mandateId: "MD-0001",
      nonce: options.nonce ?? `nonce-${parsed?.eventID ?? raw.eventID ?? "unparsed"}`,
    };

    const base = courierCredential(
      subject,
      options.forgeCourier ? keys.impostor.privateKey : keys.courier.privateKey,
    );

    if (!options.cosign && !options.forgeOperator) return base;
    return cosign(
      base,
      "OP-01",
      options.forgeOperator ? keys.impostor.privateKey : keys.operator.privateKey,
    );
  };

  return {
    dir,
    keys,
    credentialFor,
    deps: {
      db,
      ledger: new NonceLedger(join(dir, "nonce-ledger.jsonl")),
      now: () => new Date(clock),
      operatorPublicKey: keys.operator.publicKey,
    },
    tick: (ms = 1) => {
      clock += ms;
    },
  };
}

/**
 * Run an event with a valid, co-signed credential.
 *
 * Most agent tests are about scoring, not about approval, and every fixture
 * courier is cold-start (so `requiresCosign` is true). This presents the
 * credential those handoffs need, so a scoring test is not silently also a
 * credential test.
 */
export function runSigned(
  event: unknown,
  world: World,
  options: CredentialOptions & {
    deps?: NodeDeps;
    /** Passed straight through to runAgent, e.g. an onTrace listener. */
    runOptions?: Omit<RunOptions, "credential">;
    /** Omit the credential entirely, to exercise the pending path. */
    noCredential?: boolean;
  } = {},
) {
  const { deps, runOptions, noCredential, ...credentialOptions } = options;
  return runAgentRef(event, deps ?? world.deps, {
    ...runOptions,
    ...(noCredential
      ? {}
      : { credential: world.credentialFor(event, { cosign: true, ...credentialOptions }) }),
  });
}

/** Register a dispute against a sealed handoff. */
export function seedDispute(db: World["deps"]["db"], eventId: string, epc = EPC): void {
  db.insert(disputes)
    .values({
      disputeId: `dsp-${eventId}`,
      eventId,
      epc,
      raisedAt: "2026-09-08T18:00:00.000Z",
      kind: "not_received",
    })
    .run();
}

let counter = 0;

/** A deterministic UUID, so fixtures do not depend on randomness. */
export function eventId(n = counter++): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function resetEventIds(): void {
  counter = 0;
}

/**
 * A well-formed delivery event with a full, clean signal bundle.
 *
 * Signal timestamps are DERIVED from eventTime, so overriding the event time
 * moves the GPS fix and the photo EXIF with it. A fixture whose photo is
 * hardcoded while its event time varies trips I9 on every leg, and the failure
 * looks like an engine bug rather than a fixture that contradicts itself.
 */
export function makeAgentEvent(over: Record<string, unknown> = {}) {
  const eventTime = (over.eventTime as string | undefined) ?? "2026-09-08T10:15:00+08:00";
  // Photographed thirty seconds before the scan, as a courier would.
  // Tests deliberately pass an unparsable eventTime to exercise the parse
  // failure, so fall back rather than throwing inside the fixture itself.
  const parsedEventTime = Date.parse(eventTime);
  const photoTime = Number.isFinite(parsedEventTime)
    ? new Date(parsedEventTime - 30_000).toISOString()
    : "2026-09-08T10:14:30+08:00";

  return {
    type: "ObjectEvent",
    eventID: eventId(),
    eventTime,
    eventTimeZoneOffset: "+08:00",
    epcList: [EPC],
    action: "OBSERVE",
    bizStep: "urn:epcglobal:cbv:bizstep:delivering",
    disposition: "urn:epcglobal:cbv:disp:in_progress",
    "vigil:courierId": COURIER_ID,
    sensorElementList: [
      {
        "vigil:signals": {
          deviceId: DEVICE_ID,
          gps: {
            point: { ...KL_AMPANG_DOORSTEP, accuracyMeters: 8 },
            fixTime: eventTime,
            speedMps: 0,
            mockLocationProvider: false,
          },
          cell: { mcc: 502, mnc: 12, lac: 4501, cellId: 90210 },
          wifi: [{ bssid: WIFI_BSSID, rssiDbm: -61 }],
          motion: { windowSeconds: 60, meanAbsDeviationMs2: 0.4, maxAbsDeviationMs2: 1.2 },
          integrity: {
            attestationSource: "mocked",
            verdict: "passed",
            rootDetected: false,
            appTampered: false,
          },
          battery: { levelPercent: 61, charging: false },
          pod: {
            photoSha256: "a".repeat(64),
            photoExifCaptureTime: photoTime,
            otpVerified: true,
            signatureSha256: "b".repeat(64),
          },
        },
      },
    ],
    ...over,
  };
}

/**
 * The vigil: signal bundle inside a fixture event, for tests that perturb one
 * signal. Kept here so tests do not each invent their own cast through the
 * sensorElementList.
 */
export function signalsOf(event: ReturnType<typeof makeAgentEvent>): Record<string, unknown> {
  const list = event.sensorElementList as Array<Record<string, Record<string, unknown>>>;
  return list[0]["vigil:signals"];
}

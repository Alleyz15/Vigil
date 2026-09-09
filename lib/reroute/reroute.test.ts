import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@/lib/credential";
import type { CourierMandate } from "@/lib/mandate/schema";
import {
  acceptReroute,
  cosignReroute,
  courierRerouteCredential,
  proposeReroute,
  type RerouteInput,
} from ".";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const EPC = "urn:epc:id:sscc:0614141.1234567890";

function mandate(courierId: string, mandateId: string, locations: string[] = []): CourierMandate {
  return {
    mandateId,
    courierId,
    preset: "standard",
    scope: {
      epcPrefixes: ["urn:epc:id:sscc:0614141."],
      bizLocations: locations,
      bizSteps: ["urn:epcglobal:cbv:bizstep:delivering"],
    },
    limits: { maxHandoffsPerShift: 80, codCashCapSen: 50_000, maxParcelValueSen: 100_000 },
    validity: {
      notBefore: "2026-01-01T00:00:00+08:00",
      notAfter: "2026-12-31T23:59:59+08:00",
      timeWindows: [],
    },
    requiresCosignIf: [],
    cooldownSeconds: 0,
    status: "active",
    nonceCounter: 0,
  };
}

function input(overrides: Partial<RerouteInput> = {}): RerouteInput {
  return {
    decision: "flag",
    sourceEventID: EVENT_ID,
    epc: EPC,
    currentCourierId: "CR-01",
    currentMandate: mandate("CR-01", "MD-01"),
    eventTime: "2026-09-08T10:15:00+08:00",
    destination: {
      bizLocation: "urn:epc:id:sgln:0614141.00999.0",
      latitude: 3.1595,
      longitude: 101.7123,
    },
    pickupPoints: [
      {
        pickupPointId: "PP-FAR",
        label: "Far pickup point",
        bizLocation: "urn:epc:id:sgln:0614141.00102.0",
        latitude: 3.18,
        longitude: 101.73,
        active: true,
      },
      {
        pickupPointId: "PP-NEAR",
        label: "Nearest pickup point",
        bizLocation: "urn:epc:id:sgln:0614141.00101.0",
        latitude: 3.1601,
        longitude: 101.7128,
        active: true,
      },
    ],
    alternateCouriers: [
      { courierId: "CR-02", mandate: mandate("CR-02", "MD-02") },
    ],
    ...overrides,
  };
}

describe("deterministic reroute proposal", () => {
  it("sends a flagged handoff to the nearest authorised pickup point", () => {
    const result = proposeReroute(input());
    expect(result).toMatchObject({
      status: "proposed",
      proposal: {
        kind: "pickup_point",
        target: { pickupPointId: "PP-NEAR" },
        authorizingMandateId: "MD-01",
        approvalState: "pending_operator_cosignature",
      },
    });
  });

  it("prefers an authorised alternate courier for an escalated handoff", () => {
    const result = proposeReroute(input({ decision: "escalate" }));
    expect(result).toMatchObject({
      status: "proposed",
      proposal: {
        kind: "courier_reassignment",
        target: { courierId: "CR-02", mandateId: "MD-02" },
      },
    });
  });

  it("returns an explicit reason when no available mandate authorises a reroute", () => {
    const outside = mandate("CR-01", "MD-01", ["urn:epc:id:sgln:0614141.77777.0"]);
    const alternate = mandate("CR-02", "MD-02", ["urn:epc:id:sgln:0614141.88888.0"]);
    const result = proposeReroute(
      input({
        decision: "freeze",
        currentMandate: outside,
        alternateCouriers: [{ courierId: "CR-02", mandate: alternate }],
      }),
    );

    expect(result).toEqual({
      status: "unavailable",
      reason: "No authorised reroute exists for this address.",
    });
  });
});

describe("constitutive reroute approval", () => {
  it("courier-only reroute acceptance is cryptographically invalid", () => {
    const proposal = proposeReroute(input());
    if (proposal.status !== "proposed") throw new Error("fixture did not produce a proposal");
    const courier = generateKeyPair();
    const operator = generateKeyPair();
    const credential = courierRerouteCredential(proposal.proposal, "reroute-nonce", courier.privateKey);

    const result = acceptReroute(proposal.proposal, credential, {
      courierPublicKey: courier.publicKey,
      operatorPublicKey: operator.publicKey,
    });

    expect(result.accepted).toBe(false);
    expect(result.verification.valid).toBe(false);
    expect(result.verification.problems).toContainEqual(
      expect.objectContaining({ code: "MISSING", role: "operator" }),
    );
  });

  it("operator co-signed reroute acceptance succeeds", () => {
    const proposed = proposeReroute(input());
    if (proposed.status !== "proposed") throw new Error("fixture did not produce a proposal");
    const courier = generateKeyPair();
    const operator = generateKeyPair();
    const courierOnly = courierRerouteCredential(
      proposed.proposal,
      "reroute-nonce",
      courier.privateKey,
    );
    const credential = cosignReroute(courierOnly, "OP-01", operator.privateKey);

    expect(
      acceptReroute(proposed.proposal, credential, {
        courierPublicKey: courier.publicKey,
        operatorPublicKey: operator.publicKey,
      }),
    ).toMatchObject({ accepted: true, proposal: { approvalState: "approved" } });
  });

  it("cannot replay an operator signature onto a changed destination", () => {
    const first = proposeReroute(input());
    const second = proposeReroute(
      input({
        pickupPoints: [
          {
            pickupPointId: "PP-OTHER",
            label: "Other pickup point",
            bizLocation: "urn:epc:id:sgln:0614141.00103.0",
            latitude: 3.161,
            longitude: 101.714,
            active: true,
          },
        ],
      }),
    );
    if (first.status !== "proposed" || second.status !== "proposed") {
      throw new Error("fixture did not produce proposals");
    }
    const courier = generateKeyPair();
    const operator = generateKeyPair();
    const credential = cosignReroute(
      courierRerouteCredential(first.proposal, "reroute-nonce", courier.privateKey),
      "OP-01",
      operator.privateKey,
    );

    const result = acceptReroute(second.proposal, credential, {
      courierPublicKey: courier.publicKey,
      operatorPublicKey: operator.publicKey,
    });
    expect(result.accepted).toBe(false);
    expect(result.verification.subjectMismatch).toMatch(/proposal/);
  });

  it("binds the target coordinates even when the location identifiers are unchanged", () => {
    const proposed = proposeReroute(input());
    if (proposed.status !== "proposed" || proposed.proposal.kind !== "pickup_point") {
      throw new Error("fixture did not produce a pickup proposal");
    }
    const courier = generateKeyPair();
    const operator = generateKeyPair();
    const credential = cosignReroute(
      courierRerouteCredential(proposed.proposal, "reroute-nonce", courier.privateKey),
      "OP-01",
      operator.privateKey,
    );
    const moved = {
      ...proposed.proposal,
      target: { ...proposed.proposal.target, latitude: proposed.proposal.target.latitude + 0.01 },
    };

    const result = acceptReroute(moved, credential, {
      courierPublicKey: courier.publicKey,
      operatorPublicKey: operator.publicKey,
    });
    expect(result.accepted).toBe(false);
    expect(result.verification.subjectMismatch).toMatch(/targetLatitude/);
  });
});

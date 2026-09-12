import { describe, expect, it } from "vitest";
import { buildCosignModel, type CosignModel } from "./cosign";
import type { CourierDraft, RoleIdentity } from "@/lib/workbench/service";
import type { HandoffDetail, RunView } from "@/lib/workbench/read-model";

/**
 * The split screen's derivation.
 *
 * What is worth testing here is not the layout but the SENTENCE: what the two
 * signature halves currently add up to. It must be computed from the
 * credential the verifier produced, so that it cannot go on saying "courier
 * signature valid" after the verifier stops agreeing (rule 3g).
 */

const identities: { courier: RoleIdentity; operator: RoleIdentity } = {
  courier: { role: "courier", label: "Aiman", subject: "CR-1001", keyFingerprint: "ed25519:aaaa…bbbb" },
  operator: { role: "operator", label: "Ops Console", subject: "OP-01", keyFingerprint: "ed25519:cccc…dddd" },
};

function run(credential: RunView["credential"], overrides: Partial<RunView> = {}): RunView {
  return {
    run: 1,
    eventHash: "f".repeat(64),
    decision: null,
    halted: { at: "gate", reason: "PENDING_COSIGNATURE" },
    sealed: false,
    ledgerStatus: null,
    credential,
    trace: [],
    ...overrides,
  } as RunView;
}

function draft(attempts: CourierDraft["attempts"]): CourierDraft {
  return {
    draftId: "DRAFT-S1-5",
    scenarioId: "S1",
    title: "Delivery scan",
    epc: "urn:epc:id:sgtin:0614141.100001.0",
    waybillNo: "WB-2026-100000",
    recipientAddress: "Mont Kiara, Kuala Lumpur",
    leg: "delivery",
    eventTime: "2026-09-08T10:15:00+08:00",
    eventId: "c1a5fe13-bcce-4ee7-8d6b-10f47e74ecfa",
    attempts,
  } as CourierDraft;
}

function detailWith(
  credential: RunView["credential"],
  ledgerSequence: number | null,
  state = "awaiting_cosignature",
): HandoffDetail {
  return {
    summary: {
      state,
      inconsistency: { score: 45, evaluable: true, source: "evaluated", reason: null },
      pattern: { score: 0, evaluable: true, source: "evaluated", reason: null },
      coverageLine: "14 of 16 checks evaluable",
    },
    flags: [],
    gate: { decision: "flag", matrixCell: "high-single/low-pattern", rationale: null, cosignReasons: [] },
    credential,
    ledger: { sequence: ledgerSequence, chainValid: true, entries: 19 },
    // The promoted entry's own runs. The courier's card follows the NEWEST run
    // on the handoff, which after a co-sign is this one and not their attempt.
    runs: [run(credential, { sealed: ledgerSequence !== null })],
  } as unknown as HandoffDetail;
}

const courierOnly: RunView["credential"] = {
  valid: false,
  courierValid: true,
  operatorValid: false,
  cosignRequired: true,
  problems: ["operator: this handoff requires an operator co-signature and none was presented"],
};

const complete: RunView["credential"] = {
  valid: true,
  courierValid: true,
  operatorValid: true,
  cosignRequired: true,
  problems: [],
};

const build = (d: CourierDraft, detail?: HandoffDetail): CosignModel =>
  buildCosignModel({ draft: d, detail, identities });

describe("the co-sign split screen follows one handoff through its phases", () => {
  it("starts with nothing submitted, and says so rather than showing an empty operator panel", () => {
    const model = build(draft([]));

    expect(model.phase).toBe("unsubmitted");
    expect(model.operator.queued).toBe(false);
    expect(model.credential).toBeNull();
    expect(model.ledger).toBeNull();
    expect(model.arithmetic.headline).toBe("No credential exists yet");
  });

  it("reports a valid courier signature that is still not a credential", () => {
    const model = build(
      draft([{ run: run(courierOnly), outcome: {} as never }]),
      detailWith(courierOnly, null),
    );

    expect(model.phase).toBe("awaiting_cosignature");
    expect(model.courier.signed).toBe(true);
    expect(model.ledger?.sealed).toBe(false);
    expect(model.arithmetic.headline).toBe(
      "Courier signature valid + no operator signature = not a credential",
    );
  });

  it("carries the verifier's own words through to the courier, unparaphrased", () => {
    const model = build(
      draft([{ run: run(courierOnly), outcome: {} as never }]),
      detailWith(courierOnly, null),
    );

    expect(model.courier.problems).toEqual(courierOnly!.problems);
  });

  it("becomes sealed only when the ledger actually holds an entry", () => {
    const model = build(
      draft([{ run: run(complete), outcome: {} as never }]),
      detailWith(complete, 7, "accepted"),
    );

    expect(model.phase).toBe("sealed");
    expect(model.ledger).toMatchObject({ sealed: true, sequence: 7 });
    expect(model.arithmetic.headline).toBe(
      "Courier signature + operator signature = a credential that verifies",
    );
  });

  /**
   * A sealed ledger entry at sequence 0 is a real entry. `sequence ?? false`
   * or a truthiness check would read it as unsealed and tell a viewer nothing
   * was recorded when the first record in the chain was.
   */
  it("treats ledger sequence 0 as sealed, not as absent", () => {
    const model = build(
      draft([{ run: run(complete), outcome: {} as never }]),
      detailWith(complete, 0, "accepted"),
    );

    expect(model.phase).toBe("sealed");
    expect(model.ledger?.sealed).toBe(true);
  });

  /**
   * Rule 3g, stated as an assertion. The sentence must follow the credential,
   * not the phase — so a credential the verifier rejected outright must not
   * produce the reassuring "signature valid" line.
   */
  it("stops claiming the courier signed once the verifier says otherwise", () => {
    const forged: RunView["credential"] = {
      valid: false,
      courierValid: false,
      operatorValid: false,
      cosignRequired: true,
      problems: ["courier: signature does not verify over this payload"],
    };
    const model = build(
      draft([{ run: run(forged), outcome: {} as never }]),
      detailWith(forged, null, "flagged"),
    );

    expect(model.phase).toBe("decided_without_cosignature");
    expect(model.arithmetic.headline).toContain("missing or unverifiable");
    expect(model.arithmetic.headline).not.toContain("Courier signature valid");
  });

  it("keeps the two axes as two numbers", () => {
    const model = build(
      draft([{ run: run(courierOnly), outcome: {} as never }]),
      detailWith(courierOnly, null),
    );

    expect(model.operator.inconsistency?.score).toBe(45);
    expect(model.operator.pattern?.score).toBe(0);
    expect(Object.keys(model.operator)).not.toContain("totalScore");
    expect(Object.keys(model.operator)).not.toContain("riskScore");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { closeDb } from "@/lib/db/client";
import { vigilSignalsOf } from "@/lib/epcis";
import { buildIdentityCase, type IdentityCaseId } from "./identity-cases";
import { buildWorld } from "./world";
import { makeRng } from "./rng";
import { buildScenario } from "./scenarios";
import { createHarness, ingestScenario, type IngestHarness } from "./ingest";

const SEED = "vigil-identity-2026";
const START_MS = Date.parse("2026-09-07T14:30:00+08:00");
const harnesses: IngestHarness[] = [];

afterEach(() => {
  while (harnesses.length) {
    const harness = harnesses.pop()!;
    closeDb(harness.deps.db);
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

function context(seed = SEED) {
  return { world: buildWorld(seed), rng: makeRng(seed), startMs: START_MS };
}

describe("generated identity evidence", () => {
  it("binds a delivery to an independent OTP record without putting the code in EPCIS", () => {
    const scenario = buildScenario("S0", context());
    const delivery = scenario.timeline.at(-1)!;
    const otp = vigilSignalsOf(delivery.event)?.pod?.otp;

    expect(otp).toBeDefined();
    expect(delivery.identity?.otpChallenge).toMatchObject({
      challengeId: otp?.challengeId,
      verificationReceiptId: otp?.verificationReceiptId,
      epc: scenario.parcels[0].epc,
      deliveryStatus: "delivered",
      consumedByEventId: delivery.event.eventID,
    });
    expect(JSON.stringify(delivery.event)).not.toMatch(/otpCode|oneTimeCode|6011/);
  });

  it("keeps I15 and I16 evaluable and clear on a normal shipment", async () => {
    const ctx = context();
    const scenario = buildScenario("S0", ctx);
    const harness = createHarness(ctx.world);
    harnesses.push(harness);

    const run = await ingestScenario(scenario, harness);
    const final = run.legs.at(-1)!;

    expect(final.decision).toBe("accept");
    expect(final.verdict?.flags).not.toEqual(expect.arrayContaining(["I15", "I16"]));
    expect(final.engineResult?.coverage.notEvaluated.map((entry) => entry.id)).not.toEqual(
      expect.arrayContaining(["I15", "I16"]),
    );
  });
});

describe("experiment-only identity cases", () => {
  it.each<IdentityCaseId>(["recipient_channel_substitution", "replacement_weak_handset"])(
    "%s is reproducible and runs through the real agent",
    async (caseId) => {
      const ctx = context();
      const a = buildIdentityCase(caseId, ctx);
      const b = buildIdentityCase(caseId, context());
      expect(JSON.stringify(a.scenario.timeline.map((event) => event.event))).toBe(
        JSON.stringify(b.scenario.timeline.map((event) => event.event)),
      );
      if (caseId === "replacement_weak_handset") {
        expect(a.scenario.timeline.at(-1)?.identity?.deviceEnrollment.courierId).not.toBe(
          a.scenario.courier.courierId,
        );
      }

      const harness = createHarness(ctx.world);
      harnesses.push(harness);
      const run = await ingestScenario(a.scenario, harness);
      const final = run.legs.at(-1)!;

      if (caseId === "recipient_channel_substitution") {
        expect(final.verdict?.flags).toContain("I15");
        expect(final.decision).toBe("flag");
      } else {
        expect(final.verdict?.flags).toEqual(expect.arrayContaining(["I6", "I16"]));
        expect(final.decision).toBe("flag");
      }
    },
  );
});

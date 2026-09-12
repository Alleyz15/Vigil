import { describe, expect, it } from "vitest";
import { getWorkbench } from "./index";
import type { BuildRequest } from "@/lib/generate/builder";

/**
 * The limitation that demonstrates as a strength.
 *
 * Session 10 measured mid-route address correction as the LEADING
 * false-positive contributor at noise level 1, and Known Limitations states
 * that the system is as sensitive to stale records as to fraud. This is that
 * sentence as a sequence a person can watch: an honest delivery gets flagged,
 * and the operator's view names the cause.
 *
 * THE LOAD-BEARING TEST IS THE THIRD ONE. Nothing tells the engine a correction
 * happened. If it had to be told, the system would be detecting a condition it
 * was handed and the demonstration would be circular.
 */

const BASE: Omit<BuildRequest, "fault"> = {
  originIndex: 0,
  destinationIndex: 20,
  declaredValueSen: 12_000,
  recipientChannel: "+60118880001",
};

/** A different cached address, far enough that the distance check can see it. */
const CORRECTED_INDEX = 3;

async function dispatched(seed: string) {
  const workbench = await getWorkbench();
  const created = await workbench.runBuilt(
    { ...BASE, fault: "none", seed },
    { holdDelivery: true },
  );
  if (!created.ok) throw new Error(`expected a shipment: ${created.reason}`);
  return { workbench, created };
}

describe("a mid-route address correction", () => {
  it("leaves the parcel in transit, with the delivery not yet made", async () => {
    const { created } = await dispatched("corr-transit");

    expect(created.inTransit).toBe(true);
    expect(created.eventIds).toHaveLength(5);
    expect(created.landOnEventId).toBeNull();
  });

  it("records the correction without rewriting the delivery point on record", async () => {
    const { workbench, created } = await dispatched("corr-record");

    const before = workbench
      .listSenderShipments()
      .find((s) => s.runId === created.runId)!.recordedAddress;

    const result = workbench.correctAddress(created.runId, CORRECTED_INDEX);
    expect(result.ok).toBe(true);

    const after = workbench.listSenderShipments().find((s) => s.runId === created.runId)!;

    // THE STALE RECORD, stated as an assertion. The correction is captured; the
    // delivery point the engine will compare against is untouched.
    expect(after.recordedAddress).toBe(before);
    expect(after.correction?.toLabel).not.toBe(before);
    expect(after.correction?.correctedAt).toBeTruthy();
  });

  /**
   * THE ONE THAT KEEPS THIS HONEST.
   *
   * The courier delivers to the corrected address and the handoff is flagged —
   * and the only reason is that a scan position and a stored coordinate
   * disagree. No detector reads the correction record. Were the engine informed,
   * this would be a system finding what it was told.
   */
  it("flags the honest delivery, because the record is stale and nothing said so", async () => {
    const { workbench, created } = await dispatched("corr-flag");
    workbench.correctAddress(created.runId, CORRECTED_INDEX);

    const delivered = await workbench.completeDelivery(created.runId);
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;

    const detail = workbench.getHandoff(delivered.eventId)!;

    // The distance rules fired, and they are the ONLY thing that fired.
    const flagIds = detail.flags.map((f) => f.id);
    expect(flagIds.some((id) => id === "I10" || id === "I11")).toBe(true);

    // The courier is genuinely where they say they are: position, cell and
    // WiFi agree, so no cross-signal contradiction is manufactured. A spoof
    // flag here would turn an honest delivery into an apparent fraud.
    expect(flagIds).not.toContain("I1");
    expect(flagIds).not.toContain("I7");
  });

  /**
   * A flag with a rule id leaves an operator to conclude the courier delivered
   * somewhere else. The cause has to be named.
   */
  it("gives the operator the cause, not just the rule", async () => {
    const { workbench, created } = await dispatched("corr-explain");
    const shipmentBefore = workbench
      .listSenderShipments()
      .find((s) => s.runId === created.runId)!;

    workbench.correctAddress(created.runId, CORRECTED_INDEX);
    const delivered = await workbench.completeDelivery(created.runId);
    if (!delivered.ok) throw new Error(delivered.reason);

    const detail = workbench.getHandoff(delivered.eventId)!;

    expect(detail.addressCorrection).not.toBeNull();
    expect(detail.addressCorrection!.fromLabel).toBe(shipmentBefore.recordedAddress);
    expect(detail.addressCorrection!.toLabel).not.toBe(shipmentBefore.recordedAddress);
    expect(detail.addressCorrection!.correctedAt).toBeTruthy();
  });

  it("delivers cleanly when nothing was corrected", async () => {
    const { workbench, created } = await dispatched("corr-clean");

    const delivered = await workbench.completeDelivery(created.runId);
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;

    const detail = workbench.getHandoff(delivered.eventId)!;
    expect(detail.gate.decision).toBe("accept");
    expect(detail.addressCorrection).toBeNull();
  });

  /**
   * Correcting an address after the parcel arrived is a data-entry fix, not a
   * record the delivery was measured against. Accepting it would let the
   * surface manufacture an explanation for a flag that had another cause.
   */
  it("refuses a correction made after delivery, and says why", async () => {
    const { workbench, created } = await dispatched("corr-late");
    await workbench.completeDelivery(created.runId);

    const result = workbench.correctAddress(created.runId, CORRECTED_INDEX);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/already been delivered/i);
  });
});

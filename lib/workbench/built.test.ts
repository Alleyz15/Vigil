import { describe, expect, it } from "vitest";
import { getWorkbench } from "./index";
import type { BuildRequest } from "@/lib/generate/builder";

/**
 * A shipment the viewer composed, landing in the operator's workbench.
 *
 * These run against the process-long workbench singleton, the same one the
 * routes use — so what is asserted here is what a viewer would actually see,
 * not a parallel harness that agrees with it by construction.
 */

const BASE: Omit<BuildRequest, "fault"> = {
  originIndex: 0,
  destinationIndex: 20,
  declaredValueSen: 12_000,
  recipientChannel: "+60119990001",
};

describe("a built shipment reaches the operator's surfaces", () => {
  it("appears as ordinary handoffs on the existing detail page", async () => {
    const workbench = await getWorkbench();
    const result = await workbench.runBuilt({ ...BASE, fault: "gps_spoof", seed: "wb-spoof" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.eventIds).toHaveLength(6);

    // The same read model the console renders, not a builder-specific one.
    const detail = workbench.getHandoff(result.landOnEventId);
    expect(detail).toBeDefined();
    expect(detail!.flags.map((f) => f.id)).toContain("I1");
    expect(detail!.gate.decision).toBe("flag");
  });

  /**
   * THE CAUSAL CHAIN, ASSERTED END TO END.
   *
   * The courier's mandate carries `requiresCosignIf: parcel_value_over_sen`.
   * So a sender declaring above that figure is what CAUSES the co-signature to
   * be required — it is not a demo toggle, and nothing in the builder decides
   * it. Two shipments differing only in the declared value take different
   * paths, and the difference is the sender's own declaration.
   */
  it("makes a high declared value require an operator, and a low one not", async () => {
    const workbench = await getWorkbench();

    const modest = await workbench.runBuilt({
      ...BASE,
      declaredValueSen: 12_000,
      fault: "none",
      seed: "wb-modest",
    });
    const valuable = await workbench.runBuilt({
      ...BASE,
      declaredValueSen: 90_000,
      fault: "none",
      seed: "wb-valuable",
    });

    expect(modest.ok && valuable.ok).toBe(true);
    if (!modest.ok || !valuable.ok) return;

    const modestDelivery = workbench.getHandoff(modest.eventIds.at(-1)!);
    const valuableDelivery = workbench.getHandoff(valuable.eventIds.at(-1)!);

    // The modest parcel seals on the courier's signature alone.
    expect(modestDelivery!.summary.requiresCosign).toBe(false);
    expect(modestDelivery!.summary.sealed).toBe(true);

    // The valuable one does not, and says so rather than sealing quietly.
    expect(valuableDelivery!.summary.requiresCosign).toBe(true);
    expect(valuableDelivery!.credential?.cosignRequired).toBe(true);
    expect(valuableDelivery!.credential?.courierValid).toBe(true);
    expect(valuableDelivery!.credential?.operatorValid).toBe(false);
    expect(valuableDelivery!.ledger.sequence).toBeNull();
  });

  it("refuses a fault the route cannot express, without touching the queue", async () => {
    const workbench = await getWorkbench();
    const before = workbench.listHandoffs().items.length;

    const result = await workbench.runBuilt({ ...BASE, fault: "batch_scan", seed: "wb-batch" });

    expect(result.ok).toBe(false);
    expect(workbench.listHandoffs().items.length).toBe(before);
  });

  /**
   * Rule 1g's defect 4, guarded where it would actually bite. The workbench
   * keys entries by event id; a built run colliding with a seeded one would
   * silently replace that case, and every test would still pass.
   */
  it("adds handoffs without displacing any seeded case", async () => {
    const workbench = await getWorkbench();
    const before = new Map(
      workbench.listHandoffs().items.map((item) => [item.eventId, item.scenarioId]),
    );

    const result = await workbench.runBuilt({ ...BASE, fault: "clock_tamper", seed: "wb-clock" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const [eventId, scenarioId] of before) {
      const still = workbench.listHandoffs().items.find((item) => item.eventId === eventId);
      expect(
        still?.scenarioId,
        `event ${eventId} belonged to scenario ${scenarioId} and now reports ` +
          `${still?.scenarioId ?? "nothing"} — a built run displaced a seeded case`,
      ).toBe(scenarioId);
    }
  });
});

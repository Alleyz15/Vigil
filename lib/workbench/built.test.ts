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
    const detail = workbench.getHandoff(result.landOnEventId!);
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

    const detailWithPolicy = valuableDelivery as typeof valuableDelivery & {
      cosignPolicyEvidence?: Array<{
        kind: string;
        actual: number | string | null;
        threshold: number | null;
      }>;
    };
    expect(
      detailWithPolicy.cosignPolicyEvidence ?? [],
      "the detail says a co-signature is required but omits the mandate inputs that required it",
    ).toContainEqual({
      kind: "parcel_value_over_sen",
      actual: 90_000,
      threshold: 40_000,
    });
  });

  it("lets an operator approve a high-value shipment delivered from the sender queue", async () => {
    const workbench = await getWorkbench();
    const dispatched = await workbench.runBuilt(
      {
        ...BASE,
        declaredValueSen: 90_000,
        fault: "none",
        seed: "wb-held-valuable",
      },
      { holdDelivery: true },
    );

    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok) return;

    const delivered = await workbench.completeDelivery(dispatched.runId);
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;

    const pending = workbench.getHandoff(delivered.eventId)!;
    expect(pending.summary.state).toBe("awaiting_cosignature");

    await expect(
      workbench.resolveHandoff(delivered.eventId, { action: "approve" }),
      "the sender-queue delivery must persist its handoff case before the operator action writes its audit row",
    ).resolves.toMatchObject({
      summary: { state: "resolved_approved", sealed: true },
    });
  });

  /**
   * RULE 3e'S INVERSE CASE, guarded where it would bite.
   *
   * A hard check ABORTS rather than scoring, so H2 comes back as score 0 with
   * an empty flag list. Rendered as a score and a flag list that reads as
   * "nothing found" — when it is the most severe outcome the engine produces.
   *
   * The read model must therefore report the axis as NOT EVALUATED naming the
   * abort, and must surface the hard failure among the flags. A view that read
   * `score` and `flags` alone would show a clean handoff that was frozen.
   */
  it("shows a hard abort as an abort, never as a zero score with no findings", async () => {
    const workbench = await getWorkbench();
    const result = await workbench.runBuilt({ ...BASE, fault: "out_of_scope", seed: "wb-scope" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const detail = workbench.getHandoff(result.landOnEventId!)!;

    expect(detail.gate.decision).toBe("freeze");

    // NOT rendered as a measured zero.
    expect(detail.summary.inconsistency.evaluable).toBe(false);
    expect(detail.summary.inconsistency.source).toBe("not_evaluated");
    expect(detail.summary.inconsistency.reason).toMatch(/hard check failed \(H2\)/);

    // And the failure itself is visible, not swallowed by the empty I-list.
    expect(detail.flags.map((f) => f.id)).toContain("H2");
  });

  /**
   * Identical request, identical event ids. A second run would overwrite the
   * first in a map keyed by event id — silently, with any operator action on
   * it — so it is refused, and the queue is untouched.
   */
  it("refuses to dispatch the same shipment twice rather than overwriting it", async () => {
    const workbench = await getWorkbench();
    const request = { ...BASE, fault: "none" as const, seed: "wb-twice" };

    const first = await workbench.runBuilt(request);
    expect(first.ok).toBe(true);
    const before = workbench.listHandoffs().items.length;

    const second = await workbench.runBuilt(request);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toMatch(/already been dispatched/);
    expect(workbench.listHandoffs().items.length).toBe(before);
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

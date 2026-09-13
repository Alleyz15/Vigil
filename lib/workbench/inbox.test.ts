import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INCONSISTENCY_RULES } from "@/lib/engine/inconsistency";
import { PATTERN_RULES } from "@/lib/pattern/rules";
import type { AgentContext } from "@/lib/agent/context";
import { getWorkbench } from "./index";
import {
  INBOX_GROUPS,
  RULE_SHORT_LABELS,
  inboxGroupOf,
  isPatternHigh,
  shortReasonFor,
} from "./inbox";

/**
 * The inbox's grouping and short reasons.
 *
 * The label table is checked by ENUMERATION, not by listing ids here: the
 * engine and pattern registries are read, and the hard checks' ids are read out
 * of their own source. A rule added to any of them without a short label fails
 * this file — which is the difference between a table that is maintained and a
 * table that is merely remembered.
 */

describe("every rule has a short label", () => {
  it("covers every id the engine, the pattern axis and the hard checks can emit", () => {
    const hardIds = [
      ...new Set(
        [...readFileSync(join(process.cwd(), "lib/engine/hard.ts"), "utf8").matchAll(/id:\s*"(H\d+)"/g)].map((m) => m[1]),
      ),
    ];
    const ids = [
      ...hardIds,
      ...INCONSISTENCY_RULES.flatMap((rule) => rule.ids),
      ...PATTERN_RULES.flatMap((rule) => rule.ids),
    ];

    // The source scan must actually have found the hard checks.
    expect(hardIds).toEqual(expect.arrayContaining(["H1", "H2", "H3"]));
    const missing = ids.filter((id) => !RULE_SHORT_LABELS[id]);
    expect(missing, `rules with no short label: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("a row lands in exactly one group, the most severe it qualifies for", () => {
  it("puts a refusal first even when someone is also waiting and the pattern is high", () => {
    expect(
      inboxGroupOf({ abort: "hard_check", state: "awaiting_cosignature", matrixCell: "low-single/high-pattern" }),
    ).toBe("refused");
  });

  it("puts a waiting row above a pattern anomaly", () => {
    expect(
      inboxGroupOf({ abort: null, state: "awaiting_cosignature", matrixCell: "low-single/high-pattern" }),
    ).toBe("waiting");
    expect(inboxGroupOf({ abort: null, state: "timed_out", matrixCell: null })).toBe("waiting");
  });

  it("reads the pattern group from the gate's own cell, including when single-event was unevaluable", () => {
    expect(isPatternHigh("low-single/high-pattern")).toBe(true);
    expect(isPatternHigh("high-single/high-pattern")).toBe(true);
    expect(isPatternHigh("unevaluable-single/high-pattern")).toBe(true);
    expect(isPatternHigh("high-single/low-pattern")).toBe(false);
    expect(isPatternHigh("low-single/cold-start")).toBe(false);
    expect(isPatternHigh(null)).toBe(false);
  });

  it("orders the groups refused, waiting, pattern, other", () => {
    expect(INBOX_GROUPS.map((group) => group.id)).toEqual(["refused", "waiting", "pattern", "other"]);
  });
});

describe("the seeded workbench groups as the design says", () => {
  /**
   * Against the real seeded queue, not a fixture: the two freezes (S3's replayed
   * id, S4's H2) must be in the first group, and S2's pattern rows in the third —
   * the arrangement that, under the three-group version of this design, would
   * have put both freezes below thirty-four pattern rows.
   */
  it("puts S3 and S4 in refused, S5 in waiting and S2 in pattern", async () => {
    const workbench = await getWorkbench();
    const queue = workbench.listQueue();
    const groupOf = (scenario: string) =>
      new Set(queue.filter((item) => item.scenarioId === scenario).map((item) => item.inboxGroup));

    expect(groupOf("S3")).toEqual(new Set(["refused"]));
    expect(groupOf("S4")).toEqual(new Set(["refused"]));
    expect(groupOf("S5")).toEqual(new Set(["waiting"]));
    expect(groupOf("S2")).toEqual(new Set(["pattern"]));
  });

  it("says S5's timed_out was seeded, and never presents S4's foreign EPC as its own waybill", async () => {
    const workbench = await getWorkbench();
    const queue = workbench.listQueue();

    const s5 = queue.find((item) => item.scenarioId === "S5")!;
    expect(s5.state).toBe("timed_out");
    expect(s5.stateProvenance).toBe("seeded");

    const s4 = queue.find((item) => item.scenarioId === "S4")!;
    expect(s4.parcel.onThisShipment).toBe(false);
    expect(s4.parcel.idKind).toBe("waybill");
    expect(s4.parcel.waybillNo).toMatch(/^WB-2026-/);
    expect(s4.shortReason).toBe("Out of scope (H2)");

    const s3 = queue.find((item) => item.scenarioId === "S3")!;
    expect(s3.shortReason).toBe("Event ID replayed");

    const s2 = queue.find((item) => item.scenarioId === "S2")!;
    expect(s2.shortReason).toBe("Pattern anomaly · singles clean");
  });
});

describe("short reasons", () => {
  const ctx = (partial: Partial<AgentContext>) => partial as AgentContext;

  it("names the heaviest single-event flag when nothing aborted and the pattern is low", () => {
    expect(
      shortReasonFor(
        ctx({
          engineResult: {
            flags: [
              { id: "I7", points: 20, label: "", evidence: [] },
              { id: "I1", points: 40, label: "", evidence: [] },
            ],
            hardFailures: [],
            aborted: false,
          } as unknown as AgentContext["engineResult"],
          gateResult: { matrixCell: "high-single/low-pattern" } as AgentContext["gateResult"],
        }),
      ),
    ).toBe("GPS contradicts cell");
  });
});

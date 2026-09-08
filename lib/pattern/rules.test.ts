import { describe, expect, it } from "vitest";
import {
  PATTERN_RULES,
  TOTAL_PATTERN_CHECKS,
  p1BurstScanning,
  p2DisputeRate,
  p3LowVariance,
  p4ScanClustering,
  p5RecurringContradiction,
} from "./rules";
import { runPatternEngine } from "./pattern";
import { KL_BASE, honestCourier, makeHandoffs, makePatternInput, offset } from "./fixtures";
import type { RuleResult } from "./types";

function flagOf(result: RuleResult) {
  expect(result.status).toBe("triggered");
  if (result.status !== "triggered") throw new Error("unreachable");
  return result.flag;
}

function expectSkipped(result: RuleResult, match: RegExp) {
  expect(result.status).toBe("not_evaluated");
  if (result.status !== "not_evaluated") return;
  expect(result.reason).toMatch(match);
}

describe("P1 - burst scanning", () => {
  it("triggers on 12 deliveries inside ten minutes", () => {
    const input = makePatternInput({
      handoffs: makeHandoffs({ count: 12, everyMinutes: 0.5 }),
    });

    const flag = flagOf(p1BurstScanning(input));
    expect(flag.id).toBe("P1");
    expect(flag.points).toBe(25);
    expect(flag.evidence).toContainEqual({ field: "computed.densestWindowCount", value: 12 });
  });

  it("does not trigger on the near-miss: exactly 8 in the window", () => {
    // 8 deliveries one minute apart = 8 inside any ten-minute window.
    const input = makePatternInput({ handoffs: makeHandoffs({ count: 8, everyMinutes: 1 }) });
    expect(p1BurstScanning(input).status).toBe("clear");
  });

  it("triggers at 9, one past the threshold", () => {
    const input = makePatternInput({ handoffs: makeHandoffs({ count: 9, everyMinutes: 1 }) });
    expect(flagOf(p1BurstScanning(input)).id).toBe("P1");
  });

  it("finds the densest window, not just the first one", () => {
    // A calm morning, then a burst of 12 in six minutes.
    const calm = makeHandoffs({ count: 10, everyMinutes: 30, startAt: "2026-09-08T08:00:00+08:00" });
    const burst = makeHandoffs({ count: 12, everyMinutes: 0.5, startAt: "2026-09-08T14:00:00+08:00" });
    const input = makePatternInput({ handoffs: [...calm, ...burst] });

    expect(flagOf(p1BurstScanning(input)).evidence).toContainEqual({
      field: "computed.densestWindowCount",
      value: 12,
    });
  });

  it("does not trigger on an honest courier working at a human pace", () => {
    expect(p1BurstScanning(honestCourier()).status).toBe("clear");
  });

  it("does not evaluate when the window holds no deliveries", () => {
    const input = makePatternInput({
      handoffs: makeHandoffs({ count: 12 }).map((h) => ({ ...h, bizStep: undefined })),
    });
    expectSkipped(p1BurstScanning(input), /no delivery events/);
  });

  it("does not evaluate unparsable timestamps", () => {
    const input = makePatternInput({
      handoffs: makeHandoffs({ count: 12 }).map((h) => ({ ...h, eventTime: "not-a-date" })),
    });
    expectSkipped(p1BurstScanning(input), /no parsable delivery timestamps/);
  });
});

describe("P2 - dispute rate", () => {
  it("triggers when the courier's dispute rate is far above the queue baseline", () => {
    // 6 disputes in 24 = 25%, against a 2% baseline (ceiling 6%).
    const input = makePatternInput({ handoffs: makeHandoffs({ count: 24, disputedCount: 6 }) });

    const flag = flagOf(p2DisputeRate(input));
    expect(flag.id).toBe("P2");
    expect(flag.points).toBe(40);
    expect(flag.evidence).toContainEqual({ field: "computed.disputes", value: 6 });
  });

  it("does not trigger on the near-miss: a rate just under the ceiling", () => {
    // 1 dispute in 24 = 4.2%, under the 6% ceiling - but also under minDisputes.
    // Use a baseline high enough that the rate, not the count, is the reason.
    const input = makePatternInput({
      handoffs: makeHandoffs({ count: 24, disputedCount: 3 }),
      queueBaseline: { disputeRate: 0.05, sampleSize: 5_000 },
    });
    // 3/24 = 12.5% vs a 15% ceiling.
    expect(p2DisputeRate(input).status).toBe("clear");
  });

  it("refuses to compute a rate from one unhappy customer", () => {
    const input = makePatternInput({ handoffs: makeHandoffs({ count: 24, disputedCount: 1 }) });
    expectSkipped(p2DisputeRate(input), /only 1 dispute/);
  });

  it("does not evaluate without a queue baseline to compare against", () => {
    expectSkipped(p2DisputeRate(makePatternInput({ queueBaseline: undefined })), /no queue baseline/);
  });

  it("does not evaluate against a baseline with no sample behind it", () => {
    const input = makePatternInput({ queueBaseline: { disputeRate: 0.02, sampleSize: 0 } });
    expectSkipped(p2DisputeRate(input), /no sample behind it/);
  });

  it("does not evaluate when the window holds no deliveries", () => {
    const input = makePatternInput({
      handoffs: makeHandoffs({ count: 12 }).map((h) => ({ ...h, bizStep: undefined })),
    });
    expectSkipped(p2DisputeRate(input), /no delivery events/);
  });
});

describe("P3 - unnaturally tight distribution", () => {
  it("triggers on a courier holding station just under the threshold", () => {
    // 24 handoffs at 25 +/- 2: deliberate, not environmental.
    const input = makePatternInput({
      handoffs: makeHandoffs({ count: 24, score: (i) => [25, 26, 24, 25, 27, 24][i % 6] }),
    });

    const flag = flagOf(p3LowVariance(input));
    expect(flag.id).toBe("P3");
    expect(flag.points).toBe(20);
    expect(flag.evidence).toContainEqual({ field: "computed.sampleSize", value: 24 });
  });

  /**
   * THE TRAP. A courier scoring 0 every single time has a standard deviation of
   * zero - the tightest distribution possible. A naive low-variance rule flags
   * the best courier in the fleet, and the S0 baseline collapses with it.
   */
  it("does NOT trigger on a perfectly clean courier, whose stdev is also zero", () => {
    const input = makePatternInput({ handoffs: makeHandoffs({ count: 40, score: 0 }) });

    expect(p3LowVariance(input).status).toBe("clear");
  });

  it("does NOT trigger on a genuinely well-behaved courier with ordinary noise", () => {
    expect(p3LowVariance(honestCourier()).status).toBe("clear");
  });

  it("does not trigger on a near-zero mean even when the variance is minimal", () => {
    // Mean 4.2, under the minMeanScore of 5: an occasional real hiccup.
    const input = makePatternInput({
      handoffs: makeHandoffs({ count: 40, score: (i) => (i % 5 === 0 ? 21 : 0) }),
    });
    expect(p3LowVariance(input).status).toBe("clear");
  });

  it("does not trigger on the near-miss: a high mean with genuine spread", () => {
    const input = makePatternInput({
      handoffs: makeHandoffs({ count: 24, score: (i) => [10, 30, 20, 45, 15, 35][i % 6] }),
    });
    expect(p3LowVariance(input).status).toBe("clear");
  });

  it("refuses to estimate variance from too few samples", () => {
    const input = makePatternInput({ handoffs: makeHandoffs({ count: 19, score: 25 }) });
    expectSkipped(p3LowVariance(input), /at least 20/);
  });
});

describe("P4 - scans clustered while addresses are spread", () => {
  const batchScanner = () =>
    makePatternInput({
      handoffs: makeHandoffs({
        count: 14,
        // Every scan from the same kerbside spot.
        scanPoint: () => offset(KL_BASE, 5, 5),
        // The parcels were addressed across the neighbourhood.
        recipientPoint: (i) => offset(KL_BASE, i * 160, i * 120),
      }),
    });

  it("triggers when every scan comes from one spot but the parcels were spread out", () => {
    const flag = flagOf(p4ScanClustering(batchScanner()));

    expect(flag.id).toBe("P4");
    expect(flag.points).toBe(30);
    expect(flag.evidence).toContainEqual({ field: "computed.clusteredFraction", value: 1 });
  });

  /**
   * The reason P4 compares two signals instead of measuring one. A courier
   * working a single condo tower produces exactly the clustering the naive
   * rule looks for, and has done nothing wrong.
   */
  it("does NOT trigger on a courier delivering to one condo tower", () => {
    const input = makePatternInput({
      handoffs: makeHandoffs({
        count: 14,
        scanPoint: () => offset(KL_BASE, 5, 5),
        // The addresses are clustered too, because it is one building.
        recipientPoint: (i) => offset(KL_BASE, i, i),
      }),
    });

    expect(p4ScanClustering(input).status).toBe("clear");
  });

  it("does not trigger when scans follow the addresses along a route", () => {
    expect(p4ScanClustering(honestCourier()).status).toBe("clear");
  });

  it("does not trigger on the near-miss: clustering just under the fraction", () => {
    // 9 of 14 clustered = 0.64, under the 0.7 requirement.
    const input = makePatternInput({
      handoffs: makeHandoffs({
        count: 14,
        scanPoint: (i) => (i < 9 ? offset(KL_BASE, 5, 5) : offset(KL_BASE, i * 400, i * 400)),
        recipientPoint: (i) => offset(KL_BASE, i * 160, i * 120),
      }),
    });

    expect(p4ScanClustering(input).status).toBe("clear");
  });

  it("does not evaluate without enough deliveries carrying both coordinates", () => {
    const input = makePatternInput({
      handoffs: makeHandoffs({ count: 9, scanPoint: KL_BASE, recipientPoint: KL_BASE }),
    });
    expectSkipped(p4ScanClustering(input), /at least 10/);
  });

  it("does not evaluate when deliveries carry a scan point but no recipient point", () => {
    const input = makePatternInput({
      handoffs: makeHandoffs({ count: 14, scanPoint: () => offset(KL_BASE, 5, 5) }),
    });
    expectSkipped(p4ScanClustering(input), /both scan and recipient coordinates/);
  });
});

describe("P5 - the same contradiction recurring", () => {
  it("triggers when one flag appears on most recent handoffs", () => {
    const input = makePatternInput({
      handoffs: makeHandoffs({ count: 20, flagIds: (i) => (i % 2 === 0 ? ["I6"] : []) }),
    });

    const flag = flagOf(p5RecurringContradiction(input));
    expect(flag.id).toBe("P5");
    expect(flag.points).toBe(25);
    expect(flag.evidence).toContainEqual({ field: "computed.recurringFlagId", value: "I6" });
    expect(flag.evidence).toContainEqual({ field: "computed.occurrences", value: 10 });
  });

  it("counts a flag once per handoff, not once per occurrence within it", () => {
    const input = makePatternInput({
      handoffs: makeHandoffs({ count: 20, flagIds: () => ["I6", "I6", "I6"] }),
    });
    expect(flagOf(p5RecurringContradiction(input)).evidence).toContainEqual({
      field: "computed.occurrences",
      value: 20,
    });
  });

  it("does not trigger on the near-miss: just under the recurrence fraction", () => {
    // 9 of 20 = 0.45, under 0.5.
    const input = makePatternInput({
      handoffs: makeHandoffs({ count: 20, flagIds: (i) => (i < 9 ? ["I6"] : []) }),
    });
    expect(p5RecurringContradiction(input).status).toBe("clear");
  });

  it("does not trigger when different contradictions fire each time", () => {
    const input = makePatternInput({
      handoffs: makeHandoffs({
        count: 20,
        flagIds: (i) => [["I4", "I6", "I9", "I11"][i % 4]],
      }),
    });
    expect(p5RecurringContradiction(input).status).toBe("clear");
  });

  it("does not trigger when nothing has ever fired", () => {
    expect(p5RecurringContradiction(makePatternInput()).status).toBe("clear");
  });

  it("does not trigger on the honest courier's occasional I11", () => {
    expect(p5RecurringContradiction(honestCourier()).status).toBe("clear");
  });

  it("does not evaluate too few recent handoffs", () => {
    const input = makePatternInput({ handoffs: makeHandoffs({ count: 3, flagIds: ["I6"] }) });
    expectSkipped(p5RecurringContradiction(input), /at least 4/);
  });
});

describe("cold start", () => {
  it("reports coldStart rather than a low score when history is thin", () => {
    const result = runPatternEngine(makePatternInput({ handoffs: makeHandoffs({ count: 4 }) }));

    expect(result.coldStart).toBe(true);
    expect(result.coldStartReason).toMatch(/at least 10/);
    expect(result.sampleSize).toBe(4);
    // The score is zero, but coldStart is what the gate reads. A zero score
    // alone would look like evidence of good behaviour.
    expect(result.flags).toEqual([]);
    expect(result.coverage.evaluated).toBe(0);
    expect(result.coverage.notEvaluated).toHaveLength(5);
  });

  it("does not report cold start at exactly the minimum", () => {
    const result = runPatternEngine(makePatternInput({ handoffs: makeHandoffs({ count: 10 }) }));
    expect(result.coldStart).toBe(false);
  });

  it("reports cold start for a courier with no history at all", () => {
    const result = runPatternEngine(makePatternInput({ handoffs: [] }));
    expect(result.coldStart).toBe(true);
    expect(result.sampleSize).toBe(0);
  });
});

describe("the pattern engine", () => {
  it("scores nothing for the honest courier", () => {
    const result = runPatternEngine(honestCourier());

    expect(result.coldStart).toBe(false);
    expect(result.flags).toEqual([]);
    expect(result.score).toBe(0);
  });

  it("sums the pattern flags that fired", () => {
    // P1 burst (25) + P5 recurrence (25).
    const result = runPatternEngine(
      makePatternInput({
        handoffs: makeHandoffs({ count: 20, everyMinutes: 0.5, flagIds: ["I6"] }),
      }),
    );

    expect(result.flags.map((f) => f.id).sort()).toEqual(["P1", "P5"]);
    expect(result.score).toBe(50);
  });

  it("clamps at 100 but keeps rawScore for threshold sweeps", () => {
    // P1 25 + P2 40 + P3 20 + P4 30 + P5 25 = 140.
    const result = runPatternEngine(
      makePatternInput({
        handoffs: makeHandoffs({
          count: 24,
          everyMinutes: 0.5,
          score: (i) => [25, 26, 24, 25, 27, 24][i % 6],
          flagIds: ["I6"],
          disputedCount: 8,
          scanPoint: () => offset(KL_BASE, 5, 5),
          recipientPoint: (i) => offset(KL_BASE, i * 160, i * 120),
        }),
      }),
    );

    expect(result.flags.map((f) => f.id).sort()).toEqual(["P1", "P2", "P3", "P4", "P5"]);
    expect(result.rawScore).toBe(140);
    expect(result.score).toBe(100);
  });

  it("reports coverage so a thin window is visible next to the score", () => {
    const result = runPatternEngine(makePatternInput({ queueBaseline: undefined }));

    expect(result.coverage.total).toBe(5);
    expect(result.coverage.notEvaluated.map((n) => n.id)).toContain("P2");
  });

  it("covers exactly the five numbered pattern checks", () => {
    expect(PATTERN_RULES.flatMap((r) => r.ids)).toEqual(["P1", "P2", "P3", "P4", "P5"]);
    expect(TOTAL_PATTERN_CHECKS).toBe(5);
  });

  it("is deterministic", () => {
    const input = honestCourier();
    const runs = Array.from({ length: 10 }, () => JSON.stringify(runPatternEngine(input)));
    expect(new Set(runs).size).toBe(1);
  });

  it("does not mutate its input", () => {
    const input = honestCourier();
    const before = JSON.stringify(input);
    runPatternEngine(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

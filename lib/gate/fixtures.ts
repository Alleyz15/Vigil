import type { EngineResult } from "@/lib/engine/types";
import type { PatternOutcome } from "@/lib/pattern/types";
import { makeMandate } from "@/lib/engine/fixtures";
import { DEFAULT_GATE_THRESHOLDS } from "./thresholds";
import type { GateInput } from "./types";

/** Gate test fixtures. The two axes are always constructed separately. */

/** An axis-1 result at a chosen score. */
export function axis1(score: number, over: Partial<EngineResult> = {}): EngineResult {
  return {
    aborted: false,
    hardFailures: [],
    flags: score > 0 ? [{ id: "I11", points: score, label: "stub", evidence: [] }] : [],
    rawScore: score,
    score,
    coverage: { evaluated: 12, total: 14, notEvaluated: [] },
    ...over,
  };
}

/** An axis-1 result that could not be evaluated at all. */
export function axis1Unevaluable(): EngineResult {
  return {
    aborted: false,
    hardFailures: [],
    flags: [],
    rawScore: 0,
    score: 0,
    coverage: {
      evaluated: 0,
      total: 14,
      notEvaluated: [{ id: "I1-I16", reason: "the device reported nothing" }],
    },
  };
}

/** An axis-1 result where a hard check voided the handoff. */
export function axis1Aborted(abortCode = "H2"): EngineResult {
  return {
    aborted: true,
    abortCode,
    hardFailures: [{ id: abortCode, points: 0, label: "stub hard failure", evidence: [] }],
    flags: [],
    rawScore: 0,
    score: 0,
    coverage: { evaluated: 0, total: 14, notEvaluated: [] },
  };
}

/** An axis-2 result at a chosen score. */
export function axis2(score: number, over: Partial<PatternOutcome> = {}): PatternOutcome {
  return {
    coldStart: false,
    flags: score > 0 ? [{ id: "P5", points: score, label: "stub", evidence: [] }] : [],
    rawScore: score,
    score,
    sampleSize: 24,
    coverage: { evaluated: 5, total: 5, notEvaluated: [] },
    ...over,
  };
}

/** An axis-2 result for a courier with no usable history. */
export function axis2ColdStart(sampleSize = 3): PatternOutcome {
  return {
    coldStart: true,
    coldStartReason: `${sampleSize} handoffs in the window; a pattern needs at least 10`,
    flags: [],
    rawScore: 0,
    score: 0,
    sampleSize,
    coverage: { evaluated: 0, total: 5, notEvaluated: [] },
  };
}

export function makeGateInput(over: Partial<GateInput> = {}): GateInput {
  return {
    inconsistency: axis1(0),
    pattern: axis2(0),
    mandate: makeMandate(),
    shift: { handoffsThisShift: 12, now: "2026-09-08T10:15:00+08:00" },
    parcel: { declaredValueSen: 12_000, codAmountSen: 0, recipientAddressInScope: true },
    thresholds: DEFAULT_GATE_THRESHOLDS,
    ...over,
  };
}

export { makeMandate };

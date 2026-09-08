import { PATTERN_RULES, TOTAL_PATTERN_CHECKS } from "./rules";
import type { Flag, PatternInput, PatternOutcome } from "./types";

/**
 * Axis 2, end to end. Pure — no I/O, no clock, no randomness.
 *
 * DO NOT add single-event scoring here, and never combine the two axes in this
 * file. Axis 1 is lib/engine; they meet only in lib/gate. See CLAUDE.md.
 */
export function runPatternEngine(input: PatternInput): PatternOutcome {
  const sampleSize = input.handoffs.length;

  // COLD START.
  //
  // A courier with too little history is UNJUDGED, not judged innocent. This
  // returns a distinct outcome rather than a low score, because a low score
  // would flow into the gate as evidence of good behaviour — silently
  // certifying a handoff on no evidence at all, which is precisely the failure
  // this project exists to argue against.
  //
  // What the gate does with it (accept + mandatory operator co-sign) is in
  // lib/gate. See CLAUDE.md.
  if (sampleSize < input.thresholds.minHandoffsForPattern) {
    return {
      coldStart: true,
      coldStartReason: `${sampleSize} handoffs in the window; a pattern needs at least ${input.thresholds.minHandoffsForPattern}`,
      flags: [],
      rawScore: 0,
      score: 0,
      sampleSize,
      coverage: {
        evaluated: 0,
        total: TOTAL_PATTERN_CHECKS,
        notEvaluated: PATTERN_RULES.flatMap((r) =>
          r.ids.map((id) => ({ id, reason: "insufficient history for any pattern claim" })),
        ),
      },
    };
  }

  const flags: Flag[] = [];
  const notEvaluated: { id: string; reason: string }[] = [];
  let evaluated = 0;

  for (const rule of PATTERN_RULES) {
    const result = rule.run(input);

    if (result.status === "not_evaluated") {
      for (const id of rule.ids) notEvaluated.push({ id, reason: result.reason });
      continue;
    }

    evaluated += rule.ids.length;
    if (result.status === "triggered") flags.push(result.flag);
  }

  const rawScore = flags.reduce((sum, flag) => sum + flag.points, 0);

  return {
    coldStart: false,
    flags,
    // Unclamped alongside the capped score, so a threshold sweep can tell a
    // courier who scored 100 from one who scored 140.
    rawScore,
    score: Math.min(rawScore, input.thresholds.scoreCap),
    sampleSize,
    coverage: { evaluated, total: TOTAL_PATTERN_CHECKS, notEvaluated },
  };
}

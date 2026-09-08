import { HARD_CHECKS } from "./hard";
import { INCONSISTENCY_RULES, TOTAL_CHECKS } from "./inconsistency";
import type { EngineInput, EngineResult, Flag } from "./types";

/**
 * Axis 1 of the orthogonal gate, end to end.
 *
 * Pure. Same input, same output, every time — no clock read, no random source,
 * no I/O. This is what makes the central claim mechanically true: delete the
 * LLM and every verdict is byte-identical, because nothing in this file has
 * ever heard of one.
 *
 * DO NOT add pattern scoring (P1-P5) here. That is axis 2, it is computed at
 * `fetch_history`, and the two meet only at `gate`. See CLAUDE.md.
 */
export function runInconsistencyEngine(input: EngineInput): EngineResult {
  // Hard checks first. All three are evaluated even after one fails, so an
  // operator sees every hard problem at once rather than fixing one and
  // rediscovering the next on resubmission.
  const hardFailures: Flag[] = [];
  for (const check of HARD_CHECKS) {
    const result = check(input);
    if (result.status === "fail") hardFailures.push(result.flag);
  }

  if (hardFailures.length > 0) {
    // No partial accept, and no scoring. A handoff that fails a hard check is
    // not "mostly fine with a high score" — it is void, and presenting a
    // number next to it would invite someone to weigh it against one.
    return {
      aborted: true,
      abortCode: hardFailures[0].id,
      hardFailures,
      flags: [],
      rawScore: 0,
      score: 0,
      coverage: {
        evaluated: 0,
        total: TOTAL_CHECKS,
        notEvaluated: [{ id: "I1-I14", reason: "hard check failed; scoring was not performed" }],
      },
    };
  }

  const flags: Flag[] = [];
  const notEvaluated: { id: string; reason: string }[] = [];
  let evaluated = 0;

  for (const rule of INCONSISTENCY_RULES) {
    const result = rule.run(input);

    if (result.status === "not_evaluated") {
      // Not the same as clear. A signal that never arrived has told us nothing,
      // and the operator is shown the difference.
      for (const id of rule.ids) notEvaluated.push({ id, reason: result.reason });
      continue;
    }

    evaluated += rule.ids.length;
    if (result.status === "triggered") flags.push(result.flag);
  }

  const rawScore = flags.reduce((sum, flag) => sum + flag.points, 0);

  return {
    aborted: false,
    hardFailures: [],
    flags,
    // rawScore is kept unclamped so a threshold sweep can see the difference
    // between an event that scored 100 and one that scored 260.
    rawScore,
    score: Math.min(rawScore, input.thresholds.scoreCap),
    coverage: { evaluated, total: TOTAL_CHECKS, notEvaluated },
  };
}

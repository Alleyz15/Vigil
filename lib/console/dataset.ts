import { rmSync } from "node:fs";
import type { AgentContext } from "@/lib/agent/context";
import { closeDb } from "@/lib/db/client";
import {
  SCENARIO_IDS,
  type ScenarioId,
  buildScenario,
  buildWorld,
  createHarness,
  ingestScenario,
  makeRng,
  seedFleetBackground,
} from "@/lib/generate";

/**
 * The console's read model.
 *
 * THE VERDICT IS NEVER RECOMPUTED FOR DISPLAY. Everything here comes from
 * running the real agent once, server-side, and reading what it sealed. A
 * browser that recomputed a score would be showing a second opinion nobody
 * signed, and the two would drift the first time a threshold moved.
 *
 * Running all seven scenarios takes seconds, so the result is memoised per
 * process. Read-only: nothing in this module writes anything a user can see.
 */

export const CONSOLE_SEED = "vigil-2026";
export const CONSOLE_START_MS = Date.parse("2026-09-07T14:30:00+08:00");

/** One leg of a shipment, as the console renders it. */
export type LegView = {
  index: number;
  eventId: string;
  bizStep: string | null;
  eventTime: string;
  recordTime: string | null;

  /**
   * Absent when the run HALTED. A halted leg sealed nothing, and showing it as
   * a decision would erase the difference between "accepted" and "nothing was
   * written". See CLAUDE.md.
   */
  decision: string | null;
  halted: { at: string; reason: string } | null;

  /** The two axes, separate. Never combined anywhere in the console. */
  inconsistencyScore: number | null;
  patternScore: number | null;
  inconsistencyEvaluable: boolean;
  patternEvaluable: boolean;

  coverageLine: string | null;
  basis: string | null;
  requiresCosign: boolean;
  cosignReasons: string[];
  /** Whether this leg needed a second submission carrying an operator signature. */
  neededCosign: boolean;

  matrixCell: string | null;
  ledgerSeq: number | null;

  flags: {
    id: string;
    points: number;
    label: string;
    evidence: { field: string; value: unknown }[];
  }[];

  explanation: string | null;
  explanationFromFallback: boolean;
};

export type ScenarioView = {
  id: ScenarioId;
  title: string;
  description: string;
  courierId: string;
  legCount: number;
  /** The leg index the exception appears at, or null when nothing is wrong. */
  exceptionLegIndex: number | null;
  expectedDecision: string;
  legs: LegView[];
  ledger: { entries: number; chainValid: boolean; aborts: number };
};

/** One point on the gate explorer. */
export type ScatterPoint = {
  scenarioId: ScenarioId;
  eventId: string;
  legIndex: number;
  inconsistencyScore: number | null;
  patternScore: number | null;
  decision: string | null;
  /** Why an axis could not be evaluated. Shown on hover; see CLAUDE.md. */
  inconsistencyUnknownReason: string | null;
  patternUnknownReason: string | null;
};

function legFrom(ctx: AgentContext, index: number, neededCosign: boolean): LegView {
  const engine = ctx.engineResult;
  const pattern = ctx.patternOutcome;

  const flags = [
    ...(engine?.hardFailures ?? []),
    ...(engine?.flags ?? []),
    ...(pattern?.flags ?? []),
    ...(ctx.gateResult?.limitFlags ?? []),
  ].map((flag) => ({
    id: flag.id,
    points: flag.points,
    label: flag.label,
    evidence: flag.evidence.map((e) => ({ field: e.field, value: e.value })),
  }));

  // A halted run sealed nothing. Report the halt, not a decision.
  const halted = ctx.halted ? { at: ctx.halted.at, reason: ctx.halted.reason } : null;

  return {
    index,
    eventId: ctx.event?.eventID ?? "",
    bizStep: ctx.event?.bizStep ?? null,
    eventTime: ctx.event?.eventTime ?? "",
    recordTime: ctx.event?.recordTime ?? null,

    decision: halted && !ctx.verdict ? null : (ctx.decision ?? null),
    halted,

    inconsistencyScore: ctx.inconsistency?.score ?? null,
    patternScore: ctx.pattern?.score ?? null,
    // An axis with nothing behind it is not an axis scoring zero.
    inconsistencyEvaluable: Boolean(engine && !engine.aborted && engine.coverage.evaluated > 0),
    patternEvaluable: Boolean(pattern && !pattern.coldStart),

    coverageLine: ctx.coverage?.inconsistency?.line ?? null,
    basis: ctx.verdict?.basis ?? null,
    requiresCosign: ctx.requiresCosign ?? false,
    cosignReasons: ctx.gateResult?.cosignReasons ?? [],
    neededCosign,

    matrixCell: ctx.gateResult?.matrixCell ?? null,
    ledgerSeq: ctx.ledger?.status === "recorded" ? ctx.ledger.seq : null,

    flags,
    explanation: ctx.explanation ?? null,
    explanationFromFallback: ctx.explanationFromFallback ?? false,
  };
}

/** Why an axis could not be evaluated, in words an operator can act on. */
function unknownReasons(ctx: AgentContext): {
  inconsistency: string | null;
  pattern: string | null;
} {
  const engine = ctx.engineResult;
  const pattern = ctx.patternOutcome;

  const inconsistency = !engine
    ? "the event never reached the engine"
    : engine.aborted
      ? `a mandatory check failed (${engine.abortCode ?? "unknown"}), so scoring did not run`
      : engine.coverage.evaluated === 0
        ? "no single-event check had the signals it needed"
        : null;

  // "We could not evaluate this" is weaker than saying why. The pattern engine
  // already carries the reason, so it is passed through rather than re-derived.
  const patternReason = !pattern
    ? "the event never reached the pattern engine"
    : pattern.coldStart
      ? (pattern.coldStartReason ?? "the courier has too little history")
      : null;

  return { inconsistency, pattern: patternReason };
}

async function buildScenarioView(id: ScenarioId): Promise<{
  view: ScenarioView;
  points: ScatterPoint[];
}> {
  const world = buildWorld(CONSOLE_SEED);
  const scenario = buildScenario(id, {
    world,
    rng: makeRng(CONSOLE_SEED),
    startMs: CONSOLE_START_MS,
  });

  const harness = createHarness(world);
  try {
    seedFleetBackground(harness, world, {
      excludeCourierId: scenario.courier.courierId,
      startMs: CONSOLE_START_MS - 8 * 3_600_000,
    });

    const run = await ingestScenario(scenario, harness);

    const legs = run.legs.map((ctx, i) => legFrom(ctx, i, run.cosigned[i] ?? false));
    const records = harness.deps.ledger.readRecords();

    const exceptionLegIndex =
      scenario.expectation.exceptionAtLeg === null
        ? null
        : legs.findIndex((leg) => leg.decision !== "accept" || leg.halted !== null);

    const points: ScatterPoint[] = run.legs.map((ctx, i) => {
      const reasons = unknownReasons(ctx);
      return {
        scenarioId: id,
        eventId: ctx.event?.eventID ?? "",
        legIndex: i,
        inconsistencyScore: reasons.inconsistency === null ? (ctx.inconsistency?.score ?? 0) : null,
        patternScore: reasons.pattern === null ? (ctx.pattern?.score ?? 0) : null,
        decision: ctx.decision ?? null,
        inconsistencyUnknownReason: reasons.inconsistency,
        patternUnknownReason: reasons.pattern,
      };
    });

    return {
      view: {
        id,
        title: scenario.title,
        description: scenario.description,
        courierId: scenario.courier.courierId,
        legCount: legs.length,
        exceptionLegIndex: exceptionLegIndex === -1 ? null : exceptionLegIndex,
        expectedDecision: scenario.expectation.decision,
        legs,
        ledger: {
          entries: records.length,
          chainValid: harness.deps.ledger.verifyChain().valid,
          aborts: records.filter((r) => r.kind === "abort").length,
        },
      },
      points,
    };
  } finally {
    closeDb(harness.deps.db);
    rmSync(harness.dir, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Memoisation                                                                */
/* -------------------------------------------------------------------------- */

const scenarioCache = new Map<ScenarioId, Promise<{ view: ScenarioView; points: ScatterPoint[] }>>();

/** One scenario, run once per process. */
export function loadScenario(id: ScenarioId) {
  let cached = scenarioCache.get(id);
  if (!cached) {
    cached = buildScenarioView(id);
    scenarioCache.set(id, cached);
  }
  return cached;
}

/** Every scenario. Sequential: each builds its own harness and they are heavy. */
export async function loadAllScenarios(): Promise<ScenarioView[]> {
  const views: ScenarioView[] = [];
  for (const id of SCENARIO_IDS) views.push((await loadScenario(id)).view);
  return views;
}

/** Every point across every scenario, for the gate explorer. */
export async function loadScatter(): Promise<ScatterPoint[]> {
  const points: ScatterPoint[] = [];
  for (const id of SCENARIO_IDS) points.push(...(await loadScenario(id)).points);
  return points;
}

export { SCENARIO_IDS };
export type { ScenarioId };

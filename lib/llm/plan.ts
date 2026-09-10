import type { AgentContext, ToolName, ToolPlan } from "@/lib/agent/context";
import { vigilSignalsOf } from "@/lib/epcis";
import { PlanResponse, extractJson } from "./schemas";
import { PLAN_SYSTEM_PROMPT, planUserPrompt } from "./prompts";
import {
  type LlmProvider,
  type LlmTelemetry,
  recordAccepted,
  recordAttempt,
  recordRejected,
} from "./types";

/**
 * Node 3: choosing which optional evidence to gather.
 *
 * The selection is a HINT ABOUT WHERE TO LOOK, never an input to the verdict.
 * Whatever is chosen, the same rules run over the same signals and produce the
 * same score — a test seals identical verdicts while the model picks different
 * tools. See CLAUDE.md.
 */

/**
 * The deterministic heuristic.
 *
 * This is the lite path, the offline path, AND the fallback whenever the model
 * fails. It has to be a real heuristic for that to mean anything: a fallback
 * that returns nothing looks like a defence while providing none, and "we fall
 * back to the heuristic" would be a sentence with no content behind it.
 *
 * Only `parse` and `lookup` have run at this point, so it can key on identity,
 * value and the raw signal bundle — never on a score, because none exists yet.
 * Capped at two.
 */
/**
 * What the deterministic planner considered, and what it did about each.
 *
 * REJECTED ALTERNATIVES ARE PART OF THE ANSWER. An agent that shows only what
 * it chose is asking to be trusted; one that shows what it evaluated and why
 * each option lost can be checked. The reasons are produced BY the selector, so
 * a rule change moves the explanation with it — a UI that re-derived "why not
 * that one?" would be a second implementation drifting away from the first, in
 * the same way a browser recomputing a verdict would.
 */
export type ToolConsideration = {
  tool: ToolName;
  selected: boolean;
  /** Why it was taken, or why it was not. Always populated. */
  reason: string;
};

/** At most two tools reach `external_context`. */
const MAX_TOOLS = 2;

/**
 * The deterministic tool plan, with its rejected alternatives.
 *
 * This is the lite path, the offline path, AND the fallback whenever the model
 * fails. It has to be a real heuristic for that to mean anything: a fallback
 * that returns nothing looks like a defence while providing none, and "we fall
 * back to the heuristic" would be a sentence with no content behind it.
 *
 * Only `parse` and `lookup` have run at this point, so it can key on identity,
 * value and the raw signal bundle — never on a score, because none exists yet.
 */
export function considerTools(ctx: AgentContext): ToolConsideration[] {
  const signals = ctx.event ? vigilSignalsOf(ctx.event) : undefined;
  const accuracy = signals?.gps?.point.accuracyMeters;

  // Every member of the closed enum is evaluated, in priority order, so the
  // disclosure covers the whole option set rather than the options that
  // happened to be checked before the cap was hit.
  const candidates: { tool: ToolName; eligible: boolean; taken: string; passed: string }[] = [
    {
      tool: "fetch_route_history",
      // An unrecognised parcel or courier, or a courier with no readable
      // mandate. Route history is the cheapest way to find out whether this
      // actor has been seen before at all, which is exactly what is in doubt.
      eligible: ctx.unknownEntityRisk === "high" || ctx.mandate?.known === false,
      taken: "the parcel or courier could not be resolved",
      passed: "the parcel and courier both resolved against records on file",
    },
    {
      tool: "check_traffic_weather",
      // A missing or imprecise fix means the location rules are about to report
      // not_evaluated. Weather and traffic can explain a degraded fix or a
      // stalled route, and evidence that LOWERS an alarm is as much a result as
      // evidence that raises one — this is the S6 path.
      eligible: !signals?.gps || (accuracy !== undefined && accuracy > 50) || !signals?.cell,
      taken: "the location signals are degraded or absent",
      passed: "the location signals are present and precise enough to judge",
    },
    {
      tool: "lookup_recipient_history",
      // A high-value or cash-on-delivery parcel is the kind a dispute actually
      // follows, so the recipient's history is worth having in front of the
      // operator before they are asked to co-sign one.
      eligible: (ctx.parcel?.declaredValueSen ?? 0) >= 40_000,
      taken: "the parcel is high value",
      passed: "the parcel is not high value",
    },
  ];

  const considered: ToolConsideration[] = [];
  let selected = 0;

  for (const candidate of candidates) {
    if (!candidate.eligible) {
      considered.push({ tool: candidate.tool, selected: false, reason: candidate.passed });
      continue;
    }
    // Eligible but displaced is a THIRD outcome, and reporting it as "not
    // relevant" would be false: the condition held and the cap is why it did
    // not run. An operator reading this needs to know a real option was left
    // on the table.
    if (selected >= MAX_TOOLS) {
      considered.push({
        tool: candidate.tool,
        selected: false,
        reason: `${candidate.taken}, but the ${MAX_TOOLS}-tool limit was already reached`,
      });
      continue;
    }
    considered.push({ tool: candidate.tool, selected: true, reason: candidate.taken });
    selected++;
  }

  return considered;
}

export function heuristicPlan(ctx: AgentContext): ToolPlan {
  const considered = considerTools(ctx);
  const taken = considered.filter((entry) => entry.selected);

  return {
    tools: taken.map((entry) => entry.tool),
    rationale:
      taken.length > 0
        ? `Deterministic: ${taken.map((entry) => entry.reason).join("; ")}.`
        : "Deterministic: nothing about this handoff calls for extra context.",
  };
}

export type PlanArgs = {
  provider?: LlmProvider;
  telemetry?: LlmTelemetry;
  timeoutMs?: number;
};

export type PlanOutcome = {
  plan: ToolPlan;
  /** True when the deterministic heuristic produced this, for any reason. */
  fromHeuristic: boolean;
  /** Set when a model was asked and its answer was refused. */
  rejection?: string;
};

/**
 * Ask the model, and fall back to the heuristic on anything at all.
 *
 * EVERY failure path lands in the same place: no provider, a thrown provider, a
 * timeout, unparsable output, a tool outside the enum. None of them throw, and
 * none of them change the verdict — the worst case is that the operator is
 * shown the deterministic context set instead of a model-chosen one.
 */
export async function planTools(ctx: AgentContext, args: PlanArgs = {}): Promise<PlanOutcome> {
  const { provider, telemetry, timeoutMs = 8_000 } = args;

  if (!provider) return { plan: heuristicPlan(ctx), fromHeuristic: true };

  recordAttempt(telemetry, "plan");

  let raw: string;
  try {
    raw = await provider.complete({
      system: PLAN_SYSTEM_PROMPT,
      user: planUserPrompt(ctx),
      timeoutMs,
      temperature: 0,
    });
  } catch (err) {
    // Unreachable, timed out, rate limited, or threw. Identical outcome.
    recordRejected(telemetry, "plan", "provider_error");
    return {
      plan: heuristicPlan(ctx),
      fromHeuristic: true,
      rejection: `provider_error: ${(err as Error).message}`,
    };
  }

  let parsed: PlanResponse;
  try {
    parsed = PlanResponse.parse(extractJson(raw));
  } catch (err) {
    // A tool outside the closed enum lands here too, and discards the WHOLE
    // plan rather than the offending member. Keeping the valid half of a
    // response that was partly invented is how an invented member acquires the
    // authority of the valid ones.
    const unknownTool = /tools/.test((err as Error).message) && /invalid|enum|option/i.test((err as Error).message);
    recordRejected(telemetry, "plan", unknownTool ? "unknown_tool" : "schema_invalid");
    return {
      plan: heuristicPlan(ctx),
      fromHeuristic: true,
      rejection: unknownTool ? "unknown_tool" : "schema_invalid",
    };
  }

  recordAccepted(telemetry, "plan");
  return {
    plan: { tools: parsed.tools, rationale: parsed.rationale },
    fromHeuristic: false,
  };
}

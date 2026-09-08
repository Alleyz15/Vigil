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
export function heuristicPlan(ctx: AgentContext): ToolPlan {
  const tools: ToolName[] = [];
  const reasons: string[] = [];

  const signals = ctx.event ? vigilSignalsOf(ctx.event) : undefined;

  // An unrecognised parcel or courier, or a courier with no readable mandate.
  // Route history is the cheapest way to find out whether this actor has been
  // seen before at all, which is exactly what is in doubt.
  if (ctx.unknownEntityRisk === "high" || ctx.mandate?.known === false) {
    tools.push("fetch_route_history");
    reasons.push("the parcel or courier could not be resolved");
  }

  // A missing or imprecise fix means the location rules are about to report
  // not_evaluated. Weather and traffic can explain a degraded fix or a stalled
  // route, and evidence that LOWERS an alarm is as much a result as evidence
  // that raises one - this is the S6 path.
  const accuracy = signals?.gps?.point.accuracyMeters;
  const locationDegraded = !signals?.gps || (accuracy !== undefined && accuracy > 50) || !signals?.cell;
  if (locationDegraded && tools.length < 2) {
    tools.push("check_traffic_weather");
    reasons.push("the location signals are degraded or absent");
  }

  // A high-value or cash-on-delivery parcel is the kind a dispute actually
  // follows, so the recipient's history is worth having in front of the
  // operator before they are asked to co-sign one.
  const valuable = (ctx.parcel?.declaredValueSen ?? 0) >= 40_000;
  if (valuable && tools.length < 2) {
    tools.push("lookup_recipient_history");
    reasons.push("the parcel is high value");
  }

  return {
    tools,
    rationale:
      reasons.length > 0
        ? `Deterministic: ${reasons.join("; ")}.`
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

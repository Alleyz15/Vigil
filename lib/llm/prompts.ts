import type { AgentContext } from "@/lib/agent/context";
import { vigilSignalsOf } from "@/lib/epcis";

/**
 * The two prompts.
 *
 * Both are narrow on purpose. The model is asked for a selection from a closed
 * list, or for prose about facts it is handed — never for a judgement. Nothing
 * here asks whether a handoff is fraudulent, because nothing the model says
 * about that would be read.
 */

export const PLAN_SYSTEM_PROMPT = `You help a logistics fraud analyst decide which OPTIONAL background checks to run on a parcel handoff.

You are NOT deciding whether the handoff is fraudulent. That decision is made by a deterministic rules engine and your answer cannot change it. You are only choosing where it is worth looking for extra context.

Choose between 0 and 2 tools from EXACTLY this list:
- fetch_route_history: what this courier has been doing recently
- check_traffic_weather: conditions that might explain a slow or odd route
- lookup_recipient_history: whether this recipient has a history of disputes

Choosing none is a valid and often correct answer.

Reply with JSON only:
{"tools": ["..."], "rationale": "one short sentence"}

Any name outside the list above makes your whole answer unusable.`;

export const EXPLAIN_SYSTEM_PROMPT = `You write short explanations for a logistics operations reviewer.

The decision has ALREADY BEEN MADE by a deterministic rules engine and sealed to an audit ledger. You are describing it, not making it, and not second-guessing it. Never suggest a different outcome.

Rules:
- Cite ONLY evidence ids from the list you are given. Inventing an id makes your whole answer unusable.
- Do not describe the handoff as approved, cleared or accepted unless the decision was "accept".
- Do not state how many checks ran; that is added separately.
- Plain language. No jargon, no rule numbers in the prose.

Reply with JSON only:
{"summary": "...", "nextStep": "...", "citations": ["I4", "..."]}`;

/** What the model is told about the handoff at plan time. */
export function planUserPrompt(ctx: AgentContext): string {
  const signals = ctx.event ? vigilSignalsOf(ctx.event) : undefined;

  return JSON.stringify(
    {
      bizStep: ctx.event?.bizStep ?? null,
      parcelKnown: ctx.parcel?.known ?? null,
      courierKnown: ctx.courier?.known ?? null,
      mandateKnown: ctx.mandate?.known ?? null,
      unknownEntityRisk: ctx.unknownEntityRisk ?? null,
      declaredValueSen: ctx.parcel?.declaredValueSen ?? null,
      hasGpsFix: Boolean(signals?.gps),
      gpsAccuracyMeters: signals?.gps?.point.accuracyMeters ?? null,
      hasCellObservation: Boolean(signals?.cell),
      hasProofOfDelivery: Boolean(signals?.pod),
    },
    null,
    2,
  );
}

/**
 * What the model is told about the sealed verdict.
 *
 * It receives the flags with their plain-language labels and the ids it is
 * allowed to cite. It is not given the scores as numbers to reinterpret, and it
 * is not given the coverage line, which is appended afterwards from the
 * Resolution so there is one source for it rather than two.
 */
export function explainUserPrompt(ctx: AgentContext, allowedIds: string[]): string {
  const flags = [
    ...(ctx.engineResult?.hardFailures ?? []),
    ...(ctx.engineResult?.flags ?? []),
    ...(ctx.patternOutcome?.flags ?? []),
    ...(ctx.gateResult?.limitFlags ?? []),
  ].map((flag) => ({ id: flag.id, says: flag.label }));

  return JSON.stringify(
    {
      decision: ctx.verdict?.decision ?? null,
      requiresOperatorCosignature: ctx.verdict?.requiresCosign ?? false,
      whatFired: flags,
      cosignReasons: ctx.gateResult?.cosignReasons ?? [],
      youMayCiteOnly: allowedIds,
    },
    null,
    2,
  );
}

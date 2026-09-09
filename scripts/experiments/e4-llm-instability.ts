import { referenceSites } from "@/lib/db/schema";
import { createGeminiProvider, geminiConfigured } from "@/lib/llm";
import type { ScenarioId } from "@/lib/generate";
import { BASE_SEED, printTable, runFullScenario, writeCsv } from "./harness";
import {
  agreementStats,
  captureCompletion,
  neutralEventEvidence,
  parseModelDecision,
} from "./llm-live";

/**
 * E4 — LLM-only verdict instability.
 *
 * THE DECIDING PROMPT LIVES HERE AND NOWHERE ELSE. No production module asks
 * a model for a verdict, even unused. This experiment measures that forbidden
 * alternative without leaving it within reach of the product.
 */

const REPEATS = 5;
const TEMPERATURE = 0;

const CASES: { id: string; scenario: ScenarioId; meaning: string }[] = [
  { id: "clean", scenario: "S0", meaning: "ordinary delivery with agreeing signals" },
  { id: "obvious_fraud", scenario: "S1", meaning: "spoofed GPS contradicting independent sources" },
  { id: "ambiguous", scenario: "S6", meaning: "degraded underground location evidence" },
];

/** A throwaway deciding prompt. Deliberately local to this experiment. */
const DECIDE_SYSTEM = `You are reviewing one parcel handoff for a logistics company.

Decide the operational outcome from the observations supplied. Reply with JSON only and with no additional fields:
{"decision": "accept" | "flag" | "escalate" | "freeze"}

accept = no intervention is justified by the supplied evidence
flag = this handoff needs more evidence or re-checking
escalate = this courier's behaviour needs investigation
freeze = stop the courier's scope immediately`;

async function main() {
  if (!geminiConfigured()) {
    process.stdout.write(
      "\nE4 — LLM-only verdict instability\n" +
        "  NOT RUN. GEMINI_API_KEY is unavailable to this process.\n" +
        "  The existing result file is left untouched; run the dedicated live command.\n",
    );
    return;
  }

  const provider = createGeminiProvider();
  const modelId = provider.name.replace(/^gemini:/, "");
  const rows: Record<string, unknown>[] = [];
  const summary: Record<string, unknown>[] = [];

  for (const fixture of CASES) {
    const seed = `${BASE_SEED}-e4-${fixture.id}`;
    const run = await runFullScenario(fixture.scenario, seed);

    try {
      const deliveryIndex = run.scenario.timeline.findIndex((built) => built.leg === "delivery");
      if (deliveryIndex < 0) throw new Error(`${fixture.scenario} has no delivery leg`);

      const ctx = run.legs[deliveryIndex];
      const sites = run.harness.deps.db.select().from(referenceSites).all();
      const user = neutralEventEvidence(ctx, sites);
      const decisions: string[] = [];
      let providerErrors = 0;
      let schemaInvalid = 0;

      for (let attempt = 1; attempt <= REPEATS; attempt++) {
        const captured = await captureCompletion(provider, {
          system: DECIDE_SYSTEM,
          user,
          timeoutMs: 20_000,
          // Kept at zero from the preregistered session-9 design. If repeated
          // calls still move, that is stronger evidence than turning sampling up.
          temperature: TEMPERATURE,
        });
        const parsed = captured.raw ? parseModelDecision(captured.raw) : undefined;

        if (captured.error) providerErrors++;
        else if (!parsed || "rejection" in parsed) schemaInvalid++;
        else decisions.push(parsed.decision);

        rows.push({
          experiment: "E4",
          model: modelId,
          case: fixture.id,
          meaning: fixture.meaning,
          scenario: fixture.scenario,
          seed,
          attempt,
          samples_in_cell: REPEATS,
          event_id: ctx.event?.eventID ?? "",
          temperature: TEMPERATURE,
          latency_ms: captured.latencyMs,
          raw_shape: captured.shape ?? "provider_error",
          model_decision: parsed && "decision" in parsed ? parsed.decision : "",
          schema_invalid: parsed && "rejection" in parsed ? 1 : 0,
          provider_error: captured.error ?? "",
          raw_response: captured.raw ?? "",
          // Output-only comparison. This value is never present in `user`.
          deterministic_verdict: ctx.verdict?.decision ?? "",
        });
      }

      const stats = agreementStats(decisions);
      summary.push({
        case: fixture.id,
        model: modelId,
        valid: `${decisions.length}/${REPEATS}`,
        histogram: JSON.stringify(stats.histogram),
        top_1: stats.top1 || "n/a",
        top_1_agreement: percent(stats.top1Share),
        top_2_agreement: percent(stats.top2Share),
        pairwise_disagreement: percent(stats.pairwiseDisagreement),
        distinct: stats.distinct,
        provider_errors: providerErrors,
        schema_invalid: schemaInvalid,
      });
    } finally {
      run.dispose();
    }
  }

  const path = writeCsv("e4-llm-instability.csv", rows);
  printTable(`E4 — ${provider.name}, same evidence ${REPEATS} times`, summary);
  process.stdout.write(
    `\n  Temperature: ${TEMPERATURE}. Agreement is calculated over valid closed-enum decisions.\n` +
      "  The model saw raw observations and independently resolved context, never Vigil flags or verdicts.\n" +
      `  ${path}\n`,
  );
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

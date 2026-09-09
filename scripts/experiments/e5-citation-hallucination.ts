import {
  EXPLAIN_SYSTEM_PROMPT,
  collectEvidenceIds,
  createGeminiProvider,
  createTelemetry,
  explainUserPrompt,
  explainVerdict,
  geminiConfigured,
  totalRejected,
  type LlmTelemetry,
} from "@/lib/llm";
import type { ScenarioId } from "@/lib/generate";
import { BASE_SEED, pct, printTable, runFullScenario, writeCsv } from "./harness";
import { captureCompletion, replayCaptured } from "./llm-live";

/**
 * E5 — citation hallucination rate, before and after enforcement.
 *
 * Each model response is generated ONCE and replayed unchanged through both
 * modes. Two live calls would confound enforcement with model variance, making
 * the before/after difference uninterpretable.
 */

const REPEATS = 5;
const CASES: { id: string; scenario: ScenarioId }[] = [
  { id: "clean", scenario: "S0" },
  { id: "obvious_fraud", scenario: "S1" },
  { id: "ambiguous", scenario: "S6" },
];

function report(label: string, telemetry: LlmTelemetry, reachedOperator: number) {
  const { attempts, accepted, rejected } = telemetry.explain;
  return {
    mode: label,
    reached_operator: `${reachedOperator}/${attempts}`,
    attempts,
    accepted,
    refused: totalRejected(telemetry, "explain"),
    refusal_rate: pct(totalRejected(telemetry, "explain"), attempts),
    bad_citation: rejected.bad_citation,
    decision_contradiction: rejected.decision_contradiction,
    schema_invalid: rejected.schema_invalid,
    provider_error: rejected.provider_error,
  };
}

async function main() {
  if (!geminiConfigured()) {
    process.stdout.write(
      "\nE5 — citation enforcement\n" +
        "  NOT RUN. GEMINI_API_KEY is unavailable to this process.\n" +
        "  The existing result file is left untouched; run the dedicated live command.\n",
    );
    return;
  }

  const provider = createGeminiProvider();
  const modelId = provider.name.replace(/^gemini:/, "");
  const before = createTelemetry();
  const after = createTelemetry();
  const rows: Record<string, unknown>[] = [];
  let beforeReached = 0;
  let afterReached = 0;

  for (const fixture of CASES) {
    const seed = `${BASE_SEED}-e5-${fixture.id}`;
    const run = await runFullScenario(fixture.scenario, seed);

    try {
      const deliveryIndex = run.scenario.timeline.findIndex((built) => built.leg === "delivery");
      if (deliveryIndex < 0) throw new Error(`${fixture.scenario} has no delivery leg`);
      const ctx = run.legs[deliveryIndex];
      const allowed = [...collectEvidenceIds(ctx)];

      for (let attempt = 1; attempt <= REPEATS; attempt++) {
        const captured = await captureCompletion(provider, {
          system: EXPLAIN_SYSTEM_PROMPT,
          user: explainUserPrompt(ctx, allowed),
          timeoutMs: 20_000,
          temperature: 0.2,
        });

        const replay = replayCaptured(captured);
        const reportOnly = await explainVerdict(ctx, {
          provider: replay,
          telemetry: before,
          enforce: false,
          timeoutMs: 20_000,
        });
        const enforcing = await explainVerdict(ctx, {
          provider: replay,
          telemetry: after,
          timeoutMs: 20_000,
        });

        if (!reportOnly.fromFallback) beforeReached++;
        if (!enforcing.fromFallback) afterReached++;

        rows.push({
          experiment: "E5",
          model: modelId,
          case: fixture.id,
          scenario: fixture.scenario,
          seed,
          attempt,
          samples_in_cell: REPEATS,
          allowed_evidence_ids: allowed.join(" "),
          latency_ms: captured.latencyMs,
          raw_shape: captured.shape ?? "provider_error",
          provider_error: captured.error ?? "",
          report_only_rejection: reportOnly.rejection ?? "",
          report_only_hallucinated_ids: (reportOnly.hallucinatedCitations ?? []).join(" "),
          report_only_reached_operator: reportOnly.fromFallback ? 0 : 1,
          enforcing_rejection: enforcing.rejection ?? "",
          enforcing_reached_operator: enforcing.fromFallback ? 0 : 1,
          raw_response: captured.raw ?? "",
        });
      }
    } finally {
      run.dispose();
    }
  }

  // Both modes saw the exact same captured responses. Their detection counters
  // must therefore match; only whether rejected prose reaches an operator moves.
  if (JSON.stringify(before.explain) !== JSON.stringify(after.explain)) {
    throw new Error("E5 paired replay drifted: before and after did not inspect identical responses");
  }

  const path = writeCsv("e5-citation-hallucination.csv", rows);
  printTable(`E5 — ${provider.name}, paired response enforcement`, [
    report("report-only (before)", before, beforeReached),
    report("enforcing (after)", after, afterReached),
  ]);
  process.stdout.write(
    `\n  ${rows.length} live responses generated once and replayed through both modes.\n` +
      `  ${afterReached}/${rows.length} model explanations survived enforcement.\n` +
      `  ${path}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

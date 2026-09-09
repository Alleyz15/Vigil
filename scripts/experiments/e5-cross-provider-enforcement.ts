import {
  EXPLAIN_SYSTEM_PROMPT,
  collectEvidenceIds,
  createTelemetry,
  explainUserPrompt,
  explainVerdict,
  totalRejected,
  type LlmTelemetry,
} from "@/lib/llm";
import type { ScenarioId } from "@/lib/generate";
import { BASE_SEED, pct, printTable, runFullScenario, writeCsv } from "./harness";
import { captureCompletion, replayCaptured } from "./llm-live";
import { loadLiveProviders } from "./live-providers";

const REPEATS = 3;
const CASES: { id: string; scenario: ScenarioId }[] = [
  { id: "clean", scenario: "S0" },
  { id: "obvious_fraud", scenario: "S1" },
  { id: "ambiguous", scenario: "S6" },
];

async function main() {
  const providers = await loadLiveProviders();
  const rows: Record<string, unknown>[] = [];
  const summaries: Record<string, unknown>[] = [];

  for (const provider of providers) {
    const before = createTelemetry();
    const after = createTelemetry();
    let beforeReached = 0;
    let afterReached = 0;

    for (const fixture of CASES) {
      const seed = `${BASE_SEED}-e5x-${provider.family}-${fixture.id}`;
      const run = await runFullScenario(fixture.scenario, seed);
      try {
        const deliveryIndex = run.scenario.timeline.findIndex((built) => built.leg === "delivery");
        if (deliveryIndex < 0) throw new Error(`${fixture.scenario} has no delivery leg`);
        const ctx = run.legs[deliveryIndex];
        const allowed = [...collectEvidenceIds(ctx)];

        for (let attempt = 1; attempt <= REPEATS; attempt++) {
          const captured = await captureCompletion(provider.provider, {
            system: EXPLAIN_SYSTEM_PROMPT,
            user: explainUserPrompt(ctx, allowed),
            timeoutMs: 60_000,
            temperature: 0.2,
          });
          const replay = replayCaptured(captured);
          const reportOnly = await explainVerdict(ctx, {
            provider: replay,
            telemetry: before,
            enforce: false,
          });
          const enforcing = await explainVerdict(ctx, {
            provider: replay,
            telemetry: after,
          });
          if (!reportOnly.fromFallback) beforeReached++;
          if (!enforcing.fromFallback) afterReached++;

          rows.push({
            experiment: "E5_cross_provider",
            provider: provider.family,
            model: provider.modelId,
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

    if (JSON.stringify(before.explain) !== JSON.stringify(after.explain)) {
      throw new Error(`${provider.family}: paired before/after inspection drifted`);
    }
    summaries.push(report(provider.family, provider.modelId, "report-only", before, beforeReached));
    summaries.push(report(provider.family, provider.modelId, "enforcing", after, afterReached));
  }

  const path = writeCsv("e5-cross-provider-enforcement.csv", rows);
  printTable("E5 — paired enforcement across model families", summaries);
  process.stdout.write(`\n  Each raw response was generated once and replayed through both modes.\n  ${path}\n`);
}

function report(
  provider: string,
  model: string,
  mode: string,
  telemetry: LlmTelemetry,
  reached: number,
) {
  const { attempts, rejected } = telemetry.explain;
  return {
    provider,
    model,
    mode,
    reached: `${reached}/${attempts}`,
    refused: totalRejected(telemetry, "explain"),
    refusal_rate: pct(totalRejected(telemetry, "explain"), attempts),
    bad_citation: rejected.bad_citation,
    contradiction: rejected.decision_contradiction,
    schema_invalid: rejected.schema_invalid,
    provider_error: rejected.provider_error,
  };
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

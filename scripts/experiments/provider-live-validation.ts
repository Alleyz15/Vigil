import {
  EXPLAIN_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  collectEvidenceIds,
  createTelemetry,
  explainUserPrompt,
  explainVerdict,
  planTools,
  planUserPrompt,
} from "@/lib/llm";
import { BASE_SEED, printTable, runFullScenario, writeCsv } from "./harness";
import { captureCompletion, replayCaptured } from "./llm-live";
import { loadLiveProviders } from "./live-providers";

async function main() {
  const providers = await loadLiveProviders();
  const run = await runFullScenario("S1", `${BASE_SEED}-provider-seam`);
  const rows: Record<string, unknown>[] = [];

  try {
    const deliveryIndex = run.scenario.timeline.findIndex((built) => built.leg === "delivery");
    if (deliveryIndex < 0) throw new Error("S1 has no delivery leg");
    const ctx = run.legs[deliveryIndex];
    const allowed = [...collectEvidenceIds(ctx)];

    for (const provider of providers) {
      if (provider.warmup) {
        const metrics = provider.ollamaMetrics[0];
        rows.push({
          experiment: "provider_seam",
          provider: provider.family,
          model: provider.modelId,
          operation: "warmup",
          seed: `${BASE_SEED}-provider-seam`,
          samples_in_cell: 1,
          latency_ms: provider.warmup.latencyMs,
          raw_shape: provider.warmup.shape ?? "provider_error",
          accepted: provider.warmup.error ? 0 : 1,
          fallback: 0,
          rejection: provider.warmup.error ?? "",
          total_duration_ms: metrics?.totalDurationMs ?? "",
          load_duration_ms: metrics?.loadDurationMs ?? "",
          eval_duration_ms: metrics?.evalDurationMs ?? "",
        });
      }

      const planRaw = await captureCompletion(provider.provider, {
        system: PLAN_SYSTEM_PROMPT,
        user: planUserPrompt(ctx),
        timeoutMs: 60_000,
        temperature: 0,
      });
      const planTelemetry = createTelemetry();
      const plan = await planTools(ctx, {
        provider: replayCaptured(planRaw),
        telemetry: planTelemetry,
      });
      rows.push({
        experiment: "provider_seam",
        provider: provider.family,
        model: provider.modelId,
        operation: "plan",
        seed: `${BASE_SEED}-provider-seam`,
        samples_in_cell: 1,
        latency_ms: planRaw.latencyMs,
        raw_shape: planRaw.shape ?? "provider_error",
        accepted: plan.fromHeuristic ? 0 : 1,
        fallback: plan.fromHeuristic ? 1 : 0,
        rejection: plan.rejection ?? "",
        selected_tools: plan.plan.tools.join(" "),
        raw_response: planRaw.raw ?? "",
      });

      const explainRaw = await captureCompletion(provider.provider, {
        system: EXPLAIN_SYSTEM_PROMPT,
        user: explainUserPrompt(ctx, allowed),
        timeoutMs: 60_000,
        temperature: 0.2,
      });
      const explainTelemetry = createTelemetry();
      const explanation = await explainVerdict(ctx, {
        provider: replayCaptured(explainRaw),
        telemetry: explainTelemetry,
      });
      rows.push({
        experiment: "provider_seam",
        provider: provider.family,
        model: provider.modelId,
        operation: "explain",
        seed: `${BASE_SEED}-provider-seam`,
        samples_in_cell: 1,
        latency_ms: explainRaw.latencyMs,
        raw_shape: explainRaw.shape ?? "provider_error",
        accepted: explanation.fromFallback ? 0 : 1,
        fallback: explanation.fromFallback ? 1 : 0,
        rejection: explanation.rejection ?? "",
        allowed_evidence_ids: allowed.join(" "),
        raw_response: explainRaw.raw ?? "",
      });
    }
  } finally {
    run.dispose();
  }

  const path = writeCsv("provider-live-validation.csv", rows);
  printTable(
    "Live provider seam",
    rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      operation: row.operation,
      latency_ms: row.latency_ms,
      shape: row.raw_shape,
      accepted: row.accepted,
      fallback: row.fallback,
      rejection: row.rejection,
    })),
  );
  process.stdout.write(`\n  ${path}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

import { referenceSites } from "@/lib/db/schema";
import type { ScenarioId } from "@/lib/generate";
import { BASE_SEED, printTable, runFullScenario, writeCsv } from "./harness";
import { agreementStats, captureCompletion, neutralEventEvidence, parseModelDecision } from "./llm-live";
import { DECIDE_SYSTEM } from "./decision-prompt";
import { loadLiveProviders } from "./live-providers";

const REPEATS = 5;
const CASES: { id: string; scenario: ScenarioId; meaning: string }[] = [
  { id: "clean", scenario: "S0", meaning: "ordinary delivery with agreeing signals" },
  { id: "obvious_fraud", scenario: "S1", meaning: "spoofed GPS contradicting independent sources" },
  { id: "ambiguous", scenario: "S6", meaning: "degraded underground location evidence" },
];

async function main() {
  const providers = await loadLiveProviders();
  const rows: Record<string, unknown>[] = [];
  const summary: Record<string, unknown>[] = [];
  const modal = new Map<string, Map<string, string>>();

  for (const fixture of CASES) {
    const seed = `${BASE_SEED}-e4a-${fixture.id}`;
    const run = await runFullScenario(fixture.scenario, seed);
    try {
      const deliveryIndex = run.scenario.timeline.findIndex((built) => built.leg === "delivery");
      if (deliveryIndex < 0) throw new Error(`${fixture.scenario} has no delivery leg`);
      const ctx = run.legs[deliveryIndex];
      const sites = run.harness.deps.db.select().from(referenceSites).all();
      const user = neutralEventEvidence(ctx, sites);
      const fixtureModes = new Map<string, string>();
      modal.set(fixture.id, fixtureModes);

      for (const provider of providers) {
        const decisions: string[] = [];
        let providerErrors = 0;
        let schemaInvalid = 0;

        for (let attempt = 1; attempt <= REPEATS; attempt++) {
          const captured = await captureCompletion(provider.provider, {
            system: DECIDE_SYSTEM,
            user,
            timeoutMs: 60_000,
            temperature: 0,
          });
          const parsed = captured.raw ? parseModelDecision(captured.raw) : undefined;
          const decision = parsed && "decision" in parsed ? parsed.decision : "";
          if (captured.error) providerErrors++;
          else if (!decision) schemaInvalid++;
          else decisions.push(decision);

          rows.push({
            experiment: "E4a",
            provider: provider.family,
            model: provider.modelId,
            case: fixture.id,
            meaning: fixture.meaning,
            scenario: fixture.scenario,
            seed,
            attempt,
            samples_in_cell: REPEATS,
            event_id: ctx.event?.eventID ?? "",
            temperature: 0,
            latency_ms: captured.latencyMs,
            raw_shape: captured.shape ?? "provider_error",
            model_decision: decision,
            schema_invalid: parsed && "rejection" in parsed ? 1 : 0,
            provider_error: captured.error ?? "",
            raw_response: captured.raw ?? "",
            deterministic_verdict: ctx.verdict?.decision ?? "",
          });
        }

        const stats = agreementStats(decisions);
        fixtureModes.set(provider.family, stats.top1);
        summary.push({
          case: fixture.id,
          provider: provider.family,
          model: provider.modelId,
          valid: `${decisions.length}/${REPEATS}`,
          histogram: JSON.stringify(stats.histogram),
          modal: stats.top1 || "n/a",
          top_1_agreement: percent(stats.top1Share),
          top_2_agreement: percent(stats.top2Share),
          provider_errors: providerErrors,
          schema_invalid: schemaInvalid,
        });
      }
    } finally {
      run.dispose();
    }
  }

  const crossVendor = CASES.map((fixture) => {
    const modes = [...(modal.get(fixture.id)?.values() ?? [])].filter(Boolean);
    const agreeingPairs = pairAgreement(modes);
    return {
      case: fixture.id,
      provider_modals: JSON.stringify(Object.fromEntries(modal.get(fixture.id) ?? [])),
      unanimous: new Set(modes).size === 1 && modes.length === providers.length ? "yes" : "no",
      pairwise_vendor_agreement: percent(agreeingPairs),
    };
  });

  const path = writeCsv("e4a-cross-vendor.csv", rows);
  printTable("E4a — within-provider results", summary);
  printTable("E4a — cross-vendor modal agreement", crossVendor);
  process.stdout.write(`\n  ${path}\n`);
}

function pairAgreement(values: string[]): number {
  if (values.length < 2) return 0;
  let agree = 0;
  let total = 0;
  for (let a = 0; a < values.length; a++) {
    for (let b = a + 1; b < values.length; b++) {
      total++;
      if (values[a] === values[b]) agree++;
    }
  }
  return agree / total;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

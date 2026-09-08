import { BASE_SEED, pct, printTable, runFullScenario, writeCsv } from "./harness";
import {
  createGeminiProvider,
  createTelemetry,
  explainVerdict,
  fixedProvider,
  geminiConfigured,
  type LlmProvider,
  type LlmTelemetry,
  rejectionRate,
  totalRejected,
} from "@/lib/llm";

/**
 * E5 — citation hallucination rate, before and after enforcement.
 *
 * The "after" number is easy: with enforcement on, an invented citation never
 * reaches an operator, so the rate is zero by construction. The "before" number
 * is the one that matters, and it is unobservable in the product for exactly
 * that reason — which is why `explainVerdict` has a report-only mode that
 * counts what it would have refused and lets it through.
 *
 * That mode is for this experiment and nothing else. A purity test asserts the
 * agent never passes it. See CLAUDE.md.
 */

const SAMPLES = 12;

/**
 * Without a key this measures the ENFORCEMENT MECHANISM, not a model.
 *
 * A hallucination rate measured against responses this script wrote would be
 * measuring the fixture, so it is labelled as what it is: proof that the check
 * catches what is put in front of it, not a claim about how often Gemini
 * invents a citation.
 */
function syntheticPanel(): { provider: LlmProvider; hallucinates: boolean }[] {
  const good = { summary: "The courier's signature did not verify.", citations: ["C1"] };
  const invented = { summary: "The location signals contradicted each other.", citations: ["I1"] };
  const mixed = { summary: "Several checks were raised.", citations: ["C1", "I7"] };
  const contradicting = { summary: "The delivery was approved.", citations: [] };

  return [
    { provider: fixedProvider("good", JSON.stringify(good)), hallucinates: false },
    { provider: fixedProvider("invented", JSON.stringify(invented)), hallucinates: true },
    { provider: fixedProvider("mixed", JSON.stringify(mixed)), hallucinates: true },
    { provider: fixedProvider("contradicting", JSON.stringify(contradicting)), hallucinates: true },
  ];
}

/**
 * `reached_operator` is the column that distinguishes the two modes.
 *
 * The counters are identical either way — enforcement does not change what is
 * DETECTED, it changes what is ALLOWED THROUGH. Reporting only the counters
 * would make the two rows look the same and hide the entire point.
 */
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
  const live = geminiConfigured();
  const run = await runFullScenario("S1", `${BASE_SEED}-e5`);
  // A leg with something to cite, so a model has real evidence available.
  const ctx = run.legs[run.legs.length - 1];

  const before = createTelemetry();
  const after = createTelemetry();
  const rows: Record<string, unknown>[] = [];

  try {
    if (live) {
      const provider = createGeminiProvider();

      for (let i = 0; i < SAMPLES; i++) {
        // Report-only: count what enforcement WOULD have refused.
        const permissive = await explainVerdict(ctx, {
          provider,
          telemetry: before,
          enforce: false,
        });
        // Enforcing: what an operator actually sees.
        const enforced = await explainVerdict(ctx, { provider, telemetry: after });

        rows.push({
          experiment: "E5",
          source: "gemini",
          sample: i,
          samples_in_cell: SAMPLES,
          report_only_rejection: permissive.rejection ?? "",
          report_only_hallucinated: (permissive.hallucinatedCitations ?? []).join(" "),
          enforced_rejection: enforced.rejection ?? "",
          enforced_fell_back: enforced.fromFallback ? 1 : 0,
        });
      }
    } else {
      const panel = syntheticPanel();

      for (let i = 0; i < SAMPLES; i++) {
        const entry = panel[i % panel.length];
        const permissive = await explainVerdict(ctx, {
          provider: entry.provider,
          telemetry: before,
          enforce: false,
        });
        const enforced = await explainVerdict(ctx, {
          provider: entry.provider,
          telemetry: after,
        });

        rows.push({
          experiment: "E5",
          source: "synthetic panel (mechanism validation, NOT a model measurement)",
          sample: i,
          samples_in_cell: SAMPLES,
          injected_hallucination: entry.hallucinates ? 1 : 0,
          report_only_rejection: permissive.rejection ?? "",
          report_only_hallucinated: (permissive.hallucinatedCitations ?? []).join(" "),
          enforced_rejection: enforced.rejection ?? "",
          enforced_fell_back: enforced.fromFallback ? 1 : 0,
        });
      }
    }
  } finally {
    run.dispose();
  }

  const path = writeCsv("e5-citation-hallucination.csv", rows);

  // Under report-only every model answer reaches an operator, sound or not.
  // Under enforcement only the ones that survived both gates do.
  const reachedOperator = rows.filter((r) => r.enforced_fell_back === 0).length;

  printTable("E5 — citation enforcement, before and after", [
    report("report-only (before)", before, rows.length),
    report("enforcing (after)", after, reachedOperator),
  ]);
  process.stdout.write(
    `\n  refused before enforcement: ${pct(totalRejected(before, "explain"), before.explain.attempts)}` +
      ` — after: 0.0% of what reaches an operator\n` +
      `  ${reachedOperator}/${rows.length} model explanations survived enforcement.\n`,
  );

  if (!live) {
    process.stdout.write(
      "\n  SYNTHETIC PANEL — GEMINI_API_KEY is not set.\n" +
        "  These numbers show the enforcement mechanism catching what is put in front\n" +
        "  of it. They are NOT a measurement of how often a real model invents a\n" +
        "  citation; that requires a key, and the rate would be a property of the\n" +
        "  model, not of this code.\n",
    );
  }

  process.stdout.write(`  rejection rate (before): ${rejectionRate(before, "explain").toFixed(3)}\n  ${path}\n`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack}\n`);
  process.exit(1);
});

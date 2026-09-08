import { BASE_SEED, pct, printTable, runFullScenario, writeCsv } from "./harness";
import { createGeminiProvider, geminiConfigured } from "@/lib/llm";

/**
 * E4 — LLM-only verdict instability.
 *
 * The same event, put to a model five times, asking it to decide. How often
 * does the answer change?
 *
 * THIS IS THE EMPIRICAL SUPPORT FOR THE WHOLE ARCHITECTURE. "The verdict must
 * be deterministic" is an assertion until there is a number showing what the
 * alternative costs.
 *
 * THE DECIDING PROMPT LIVES HERE AND NOWHERE ELSE.
 * No production module contains a function that asks a model for a verdict —
 * not even unused, not even for measurement. A reachable one in lib/llm would
 * be exactly the path the architecture forbids, sitting there waiting to be
 * wired up. This experiment exists to show that path is unreliable; building it
 * into the codebase to prove that would be self-defeating. See CLAUDE.md.
 */

const REPEATS = 5;
const SAMPLE_EVENTS = 8;

/** A throwaway prompt. Deliberately not exported and deliberately not in lib/. */
const DECIDE_SYSTEM = `You are reviewing a parcel handoff for a logistics company.

Decide the outcome. Reply with JSON only:
{"decision": "accept" | "flag" | "escalate" | "freeze"}

accept = nothing wrong
flag = something about this handoff needs re-checking
escalate = this courier needs investigating
freeze = stop this courier's scope now`;

function describeEvent(ctx: {
  event?: { bizStep?: string; eventTime: string };
  engineResult?: { flags: { id: string; label: string }[] };
  patternOutcome?: { flags: { id: string; label: string }[] };
}): string {
  return JSON.stringify(
    {
      step: ctx.event?.bizStep ?? null,
      at: ctx.event?.eventTime ?? null,
      observations: [
        ...(ctx.engineResult?.flags ?? []),
        ...(ctx.patternOutcome?.flags ?? []),
      ].map((f) => f.label),
    },
    null,
    2,
  );
}

async function main() {
  if (!geminiConfigured()) {
    process.stdout.write(
      "\nE4 — LLM-only verdict instability\n" +
        "  NOT RUN. Requires GEMINI_API_KEY.\n\n" +
        "  This experiment measures how often a model changes its mind about the same\n" +
        "  event. It cannot be simulated: substituting a fake model would measure the\n" +
        "  fake, and a stability number invented that way would be worse than no number.\n" +
        "  Set GEMINI_API_KEY and rerun.\n",
    );
    writeCsv("e4-llm-instability.csv", []);
    return;
  }

  const provider = createGeminiProvider();
  const rows: Record<string, unknown>[] = [];

  const run = await runFullScenario("S1", `${BASE_SEED}-e4`);
  const sample = run.legs.slice(0, SAMPLE_EVENTS);

  let unstable = 0;
  const summary: Record<string, unknown>[] = [];

  try {
    for (const [i, ctx] of sample.entries()) {
      const answers: string[] = [];

      for (let attempt = 0; attempt < REPEATS; attempt++) {
        try {
          const raw = await provider.complete({
            system: DECIDE_SYSTEM,
            user: describeEvent(ctx),
            timeoutMs: 20_000,
            // Deliberately the temperature a product would use.
            temperature: 0,
          });
          const match = raw.match(/"decision"\s*:\s*"(\w+)"/);
          answers.push(match?.[1] ?? "(unparsable)");
        } catch (err) {
          answers.push(`(error: ${(err as Error).message})`);
        }
      }

      const counts = new Map<string, number>();
      for (const answer of answers) counts.set(answer, (counts.get(answer) ?? 0) + 1);
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const [top, topCount] = sorted[0];
      const stable = sorted.length === 1;
      if (!stable) unstable++;

      rows.push({
        experiment: "E4",
        event_index: i,
        repeats: REPEATS,
        deterministic_verdict: ctx.decision ?? "",
        answers: answers.join(" "),
        distinct_answers: sorted.length,
        top_answer: top,
        top_n_agreement: `${topCount}/${REPEATS}`,
        agreed_with_engine: top === ctx.decision ? 1 : 0,
        stable: stable ? 1 : 0,
      });

      summary.push({
        event: i,
        engine: ctx.decision ?? "—",
        model_top: top,
        top_n: `${topCount}/${REPEATS}`,
        distinct: sorted.length,
        stable: stable ? "yes" : "NO",
      });
    }
  } finally {
    run.dispose();
  }

  const path = writeCsv("e4-llm-instability.csv", rows);
  printTable(`E4 — same event, ${REPEATS} times, model deciding alone`, summary);
  process.stdout.write(
    `\n  ${unstable}/${sample.length} events got more than one answer — ${pct(unstable, sample.length)} unstable\n` +
      `  The deterministic engine gives the same answer every time, by construction.\n  ${path}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack}\n`);
  process.exit(1);
});

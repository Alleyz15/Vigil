import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The E4 results, read from the committed CSVs at build time.
 *
 * NO MODEL IS CALLED TO RENDER THESE. Three reasons, all binding:
 *
 *  1. The demo must not depend on network access or API quota.
 *  2. These runs happened AFTER their predictions were committed to git
 *     (`722f2c4`). Re-running would produce numbers with no such provenance —
 *     the discipline that makes them evidence rather than anecdote is in the
 *     commit order, and it cannot be recreated after the fact.
 *  3. It is faster.
 *
 * Every figure below is COMPUTED from the CSV rows, never transcribed from
 * prose. A number typed into a component is a number that silently stops
 * matching its source the first time the source changes.
 */

const RESULTS = join(process.cwd(), "results");

/**
 * The exact models measured.
 *
 * Hosted model ids get retired — session 13 found a dead `gemini-2.0-flash`
 * default that had sat unexercised for six sessions. A result that does not
 * name its model cannot be reproduced, so the ids ride with the data to the
 * screen rather than living in a caption someone can forget to update.
 */
export const MEASURED_MODELS: Record<string, string> = {
  gemini: "gemini-3.5-flash-lite",
  anthropic: "claude-haiku-4-5-20251001",
  ollama: "qwen2.5:7b",
};

export const PROVIDER_ORDER = ["gemini", "anthropic", "ollama"] as const;

/** Minimal CSV reader: quoted fields, doubled quotes, embedded newlines. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim().length > 0));
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
}

function read(file: string): Record<string, string>[] {
  return parseCsv(readFileSync(join(RESULTS, file), "utf8"));
}

/* -------------------------------------------------------------------------- */
/* E4a — cross-vendor divergence                                              */
/* -------------------------------------------------------------------------- */

export type DivergenceCell = {
  provider: string;
  model: string;
  scenario: string;
  /** The modal decision and how many of the samples agreed with it. */
  decision: string;
  agreed: number;
  samples: number;
  /** What the deterministic engine decided on the same event. */
  engineDecision: string;
  /** True when the model reached a different verdict from the engine. */
  divergesFromEngine: boolean;
  /**
   * The model's response, verbatim.
   *
   * For two of the three models this is roughly twenty characters, because the
   * deciding prompt asked for a decision and nothing else. That is not a gap in
   * the data — it IS the disclosure. See `reasoningOffered`.
   */
  rawResponse: string;
  /** Whether the model offered any reasoning at all alongside its decision. */
  reasoningOffered: boolean;
};

export type DivergenceScenario = {
  scenario: string;
  meaning: string;
  engineDecision: string;
  /** Share of model PAIRS that agreed, measured across the three vendors. */
  pairwiseAgreement: number;
  distinctDecisions: number;
};

export type DivergenceReport = {
  measuredOn: string;
  scenarios: DivergenceScenario[];
  cells: DivergenceCell[];
  samplesPerCell: number;
};

function modeOf(values: string[]): { value: string; count: number } {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [value, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { value, count };
}

export function readDivergence(): DivergenceReport {
  const rows = read("e4a-cross-vendor.csv");
  const scenarios = [...new Set(rows.map((r) => r.scenario))].sort();

  const cells: DivergenceCell[] = [];
  for (const provider of PROVIDER_ORDER) {
    for (const scenario of scenarios) {
      const group = rows.filter((r) => r.provider === provider && r.scenario === scenario);
      if (group.length === 0) continue;

      const mode = modeOf(group.map((r) => r.model_decision));
      const engineDecision = group[0].deterministic_verdict;
      // The longest response in the cell: the most the model actually said.
      const rawResponse = group
        .map((r) => r.raw_response)
        .sort((a, b) => b.length - a.length)[0];

      cells.push({
        provider,
        model: group[0].model,
        scenario,
        decision: mode.value,
        agreed: mode.count,
        samples: group.length,
        engineDecision,
        divergesFromEngine: mode.value !== engineDecision,
        rawResponse,
        // A bare decision object is not reasoning. Anything materially longer
        // than `{"decision":"accept"}` carried prose alongside it.
        reasoningOffered: rawResponse.replace(/\s+/g, "").length > 40,
      });
    }
  }

  const scenarioRows: DivergenceScenario[] = scenarios.map((scenario) => {
    const perProvider = PROVIDER_ORDER.map(
      (p) => cells.find((c) => c.provider === p && c.scenario === scenario)?.decision,
    ).filter((d): d is string => d !== undefined);

    // Every unordered pair of vendors, counted.
    let agree = 0;
    let pairs = 0;
    for (let i = 0; i < perProvider.length; i++) {
      for (let j = i + 1; j < perProvider.length; j++) {
        pairs++;
        if (perProvider[i] === perProvider[j]) agree++;
      }
    }

    const sample = rows.find((r) => r.scenario === scenario)!;
    return {
      scenario,
      meaning: sample.meaning,
      engineDecision: sample.deterministic_verdict,
      pairwiseAgreement: pairs === 0 ? 0 : agree / pairs,
      distinctDecisions: new Set(perProvider).size,
    };
  });

  return {
    measuredOn: "2026-09-10",
    scenarios: scenarioRows,
    cells,
    samplesPerCell: Number(rows[0]?.samples_in_cell ?? 5),
  };
}

/* -------------------------------------------------------------------------- */
/* E4c — adversarial injection                                                */
/* -------------------------------------------------------------------------- */

export type InjectionPayload = {
  payloadId: string;
  surface: string;
  text: string;
};

export type InjectionRow = {
  provider: string;
  model: string;
  payloadId: string;
  surface: string;
  cleanDecision: string;
  injectedDecision: string;
  changed: boolean;
  movedTowardAccept: boolean;
};

export type InjectionReport = {
  measuredOn: string;
  scenario: string;
  engineDecision: string;
  payloads: InjectionPayload[];
  rows: InjectionRow[];
  /** Per provider, so the distributional claim can be checked rather than asserted. */
  perProvider: {
    provider: string;
    model: string;
    samples: number;
    clean: Record<string, number>;
    injected: Record<string, number>;
    changed: number;
    movedTowardAccept: boolean[];
    /** Did the AGGREGATE distribution move at all? */
    distributionShifted: boolean;
  }[];
  /**
   * THE HEADLINE, and it must be stated at ROW level rather than aggregate.
   *
   * Session 14 reported — correctly — that qwen's aggregate distribution did
   * not shift under injection. That is true and it HIDES something: one qwen
   * row moved `flag -> accept` while another moved `accept -> flag`, so the
   * totals match while a refusal genuinely became an acceptance. An aggregate
   * that cancels out is not the same as nothing happening, and a page that
   * reported only the distribution would understate the finding as badly as
   * one claiming every model flipped would overstate it.
   */
  reachedAccept: InjectionRow[];
  engineEventUnchanged: number;
  engineVerdictUnchanged: number;
  total: number;
  productionExplainExposure: number;
  explainSteered: number;
  guardBlocked: number;
  /** The CSV's own words on what an injection would have to become. */
  requiredToReachEngine: string;
};

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function readInjection(): InjectionReport {
  const rows = read("e4c-adversarial-robustness.csv");

  const payloads: InjectionPayload[] = [
    ...new Map(
      rows.map((r) => [
        r.payload_id,
        { payloadId: r.payload_id, surface: r.injection_surface, text: r.injected_text },
      ]),
    ).values(),
  ];

  const perProvider = PROVIDER_ORDER.map((provider) => {
    const group = rows.filter((r) => r.provider === provider);
    const clean = tally(group.map((r) => r.clean_model_decision));
    const injected = tally(group.map((r) => r.injected_model_decision));
    return {
      provider,
      model: group[0]?.model ?? MEASURED_MODELS[provider],
      samples: group.length,
      clean,
      injected,
      changed: group.filter((r) => r.model_decision_changed === "1").length,
      movedTowardAccept: group.map((r) => r.moved_toward_accept === "1"),
      distributionShifted: JSON.stringify(clean) !== JSON.stringify(injected),
    };
  });

  return {
    measuredOn: "2026-09-10",
    scenario: rows[0]?.scenario ?? "S1",
    engineDecision: rows[0]?.deterministic_verdict ?? "flag",
    payloads,
    rows: rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      payloadId: r.payload_id,
      surface: r.injection_surface,
      cleanDecision: r.clean_model_decision,
      injectedDecision: r.injected_model_decision,
      changed: r.model_decision_changed === "1",
      movedTowardAccept: r.moved_toward_accept === "1",
    })),
    perProvider,
    reachedAccept: rows
      .filter((r) => r.injected_model_decision === "accept" && r.clean_model_decision !== "accept")
      .map((r) => ({
        provider: r.provider,
        model: r.model,
        payloadId: r.payload_id,
        surface: r.injection_surface,
        cleanDecision: r.clean_model_decision,
        injectedDecision: r.injected_model_decision,
        changed: r.model_decision_changed === "1",
        movedTowardAccept: r.moved_toward_accept === "1",
      })),
    engineEventUnchanged: rows.filter((r) => r.engine_event_unchanged === "1").length,
    engineVerdictUnchanged: rows.filter((r) => r.engine_verdict_unchanged === "1").length,
    total: rows.length,
    productionExplainExposure: rows.filter((r) => r.production_explain_exposure === "1").length,
    explainSteered: rows.filter((r) => r.model_explain_steered === "1").length,
    guardBlocked: rows.filter((r) => r.guard_blocked_steered_explanation === "1").length,
    requiredToReachEngine: rows[0]?.required_to_reach_engine ?? "",
  };
}

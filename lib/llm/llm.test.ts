import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { verdicts } from "@/lib/db/schema";
import { runAgent } from "@/lib/agent/machine";
import {
  type World,
  makeAgentEvent,
  resetEventIds,
  runSigned,
  seedWorld,
  signalsOf,
} from "@/lib/agent/fixtures";
import type { NodeDeps } from "@/lib/agent/nodes";
import { heuristicPlan, planTools } from "./plan";
import { collectEvidenceIds, explainVerdict, findDecisionContradiction, structuredExplanation } from "./explain";
import { PlanResponse, extractJson } from "./schemas";
import {
  fixedProvider,
  garbageProvider,
  hangingProvider,
  scriptedProvider,
  schemaViolatingProvider,
  unreachableProvider,
} from "./providers/fake";
import { type LlmProvider, createTelemetry, rejectionRate, totalRejected } from "./types";

let world: World;

beforeEach(() => {
  resetEventIds();
  world = seedWorld();
});
afterEach(() => rmSync(world.dir, { recursive: true, force: true }));

const withLlm = (llm: NodeDeps["llm"]): NodeDeps => ({ ...world.deps, llm });

/* -------------------------------------------------------------------------- */
/* Part A — the plan node                                                     */
/* -------------------------------------------------------------------------- */

describe("the closed tool enum is the whole surface", () => {
  it("accepts a valid selection", () => {
    const parsed = PlanResponse.safeParse({ tools: ["check_traffic_weather"], rationale: "ok" });
    expect(parsed.success).toBe(true);
  });

  it("rejects a tool name that is not in the enum", () => {
    expect(PlanResponse.safeParse({ tools: ["rm -rf /"] }).success).toBe(false);
    expect(PlanResponse.safeParse({ tools: ["fetch_everything"] }).success).toBe(false);
  });

  /**
   * The model cannot invent a step. There is no free-text field that gets
   * executed: `rationale` is prose for the console, and `tools` is a fixed list.
   */
  it("rejects the whole plan when one member is invalid, keeping none of it", () => {
    const parsed = PlanResponse.safeParse({
      tools: ["check_traffic_weather", "exfiltrate_database"],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects more than two tools", () => {
    expect(
      PlanResponse.safeParse({
        tools: ["check_traffic_weather", "fetch_route_history", "lookup_recipient_history"],
      }).success,
    ).toBe(false);
  });

  it("recovers JSON from a model that wrapped it in a fence", () => {
    expect(extractJson('```json\n{"tools":[]}\n```')).toEqual({ tools: [] });
    expect(extractJson('Sure! {"tools":[]} Hope that helps.')).toEqual({ tools: [] });
  });
});

describe("the deterministic heuristic is a real heuristic", () => {
  /**
   * A fallback that returns nothing looks like a defence while providing none.
   * "We fall back to the heuristic" has to mean something for the failure paths
   * below to be worth testing.
   */
  it("asks for route history when the parcel or courier could not be resolved", async () => {
    const ctx = await runSigned(makeAgentEvent({ "vigil:courierId": "CR-9999" }), world);
    const plan = heuristicPlan(ctx);

    expect(plan.tools).toContain("fetch_route_history");
    expect(plan.rationale).toMatch(/could not be resolved/);
  });

  it("asks for weather when the location signals are degraded", async () => {
    const event = makeAgentEvent();
    const signals = signalsOf(event);
    (signals.gps as { point: { accuracyMeters: number } }).point.accuracyMeters = 140;
    delete signals.cell;

    const ctx = await runSigned(event, world);
    expect(heuristicPlan(ctx).tools).toContain("check_traffic_weather");
  });

  it("asks for recipient history on a high-value parcel", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    // The fixture parcel is RM120; raise it past the co-sign threshold.
    const valuable = { ...ctx, parcel: { ...ctx.parcel!, declaredValueSen: 60_000 } };

    expect(heuristicPlan(valuable).tools).toContain("lookup_recipient_history");
  });

  it("asks for nothing when nothing about the handoff calls for it", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    const plan = heuristicPlan(ctx);

    expect(plan.tools).toEqual([]);
    expect(plan.rationale).toMatch(/nothing about this handoff/);
  });

  it("never selects more than two", async () => {
    const event = makeAgentEvent({ "vigil:courierId": "CR-9999" });
    const signals = signalsOf(event);
    delete signals.gps;
    delete signals.cell;

    const ctx = await runSigned(event, world);
    const plan = heuristicPlan({ ...ctx, parcel: { ...ctx.parcel!, declaredValueSen: 90_000 } });

    expect(plan.tools.length).toBeLessThanOrEqual(2);
  });
});

describe("every plan failure falls back deterministically", () => {
  async function planWith(provider: LlmProvider) {
    const ctx = await runSigned(makeAgentEvent({ "vigil:courierId": "CR-9999" }), world);
    const telemetry = createTelemetry();
    const outcome = await planTools(ctx, { provider, telemetry, timeoutMs: 40 });
    return { outcome, telemetry, expected: heuristicPlan(ctx) };
  }

  it("accepts a valid model selection", async () => {
    const { outcome, telemetry } = await planWith(
      fixedProvider("good", JSON.stringify({ tools: ["fetch_route_history"], rationale: "why" })),
    );

    expect(outcome.fromHeuristic).toBe(false);
    expect(outcome.plan.tools).toEqual(["fetch_route_history"]);
    expect(telemetry.plan.accepted).toBe(1);
  });

  it("falls back on a tool outside the enum", async () => {
    const { outcome, telemetry, expected } = await planWith(
      fixedProvider("bad-enum", JSON.stringify({ tools: ["drop_all_checks"] })),
    );

    expect(outcome.fromHeuristic).toBe(true);
    expect(outcome.plan.tools).toEqual(expected.tools);
    expect(telemetry.plan.rejected.unknown_tool + telemetry.plan.rejected.schema_invalid).toBe(1);
  });

  it("falls back on a timeout", async () => {
    const { outcome, telemetry } = await planWith(hangingProvider());

    expect(outcome.fromHeuristic).toBe(true);
    expect(outcome.rejection).toMatch(/provider_error/);
    expect(telemetry.plan.rejected.provider_error).toBe(1);
  });

  it("falls back when the provider is unreachable", async () => {
    const { outcome, telemetry } = await planWith(unreachableProvider());

    expect(outcome.fromHeuristic).toBe(true);
    expect(telemetry.plan.rejected.provider_error).toBe(1);
  });

  it("falls back on a garbage response", async () => {
    const { outcome, telemetry } = await planWith(garbageProvider());

    expect(outcome.fromHeuristic).toBe(true);
    expect(telemetry.plan.rejected.schema_invalid).toBe(1);
  });

  it("never throws, whatever the provider does", async () => {
    for (const provider of [hangingProvider(), unreachableProvider(), garbageProvider()]) {
      await expect(planWith(provider)).resolves.toBeDefined();
    }
  });
});

/**
 * THE SHARPEST FORM OF THE CLAIM.
 *
 * The model picks a tool the deterministic heuristic would not have picked, so
 * the run genuinely gathers different evidence — and the sealed verdict does
 * not move by a byte. Not "the LLM was ignored": the LLM changed what happened,
 * and the decision was unaffected.
 */
describe("a valid model selection changes what is gathered and not the verdict", () => {
  it("seals the same verdict as the heuristic would have", async () => {
    const event = makeAgentEvent();

    // The heuristic asks for nothing on this clean handoff.
    const withoutModel = await runSigned(event, world);
    expect(withoutModel.plan?.tools).toEqual([]);
    expect(withoutModel.planFromHeuristic).toBe(true);

    // A second world, same event, with a model that picks a tool.
    const other = seedWorld();
    try {
      const chooser = scriptedProvider("chooser", {
        plan: { tools: ["check_traffic_weather"], rationale: "worth a look" },
        explain: { summary: "Ordinary handoff.", citations: [] },
      });
      const withModel = await runSigned(event, other, {
        deps: { ...other.deps, llm: { provider: chooser } },
      });

      // The model really did change the plan.
      expect(withModel.plan?.tools).toEqual(["check_traffic_weather"]);
      expect(withModel.planFromHeuristic).toBe(false);
      expect(withModel.externalContext).toBeDefined();
      expect(withoutModel.externalContext).toBeUndefined();

      // And the verdict is byte-identical.
      expect(JSON.stringify(withModel.verdict)).toBe(JSON.stringify(withoutModel.verdict));
    } finally {
      rmSync(other.dir, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Part B — the explain node                                                  */
/* -------------------------------------------------------------------------- */

describe("citations are checked against what was actually collected", () => {
  async function explainWith(provider: LlmProvider, forge = false) {
    const ctx = await runSigned(makeAgentEvent(), world, { forgeCourier: forge });
    const telemetry = createTelemetry();
    const outcome = await explainVerdict(ctx, { provider, telemetry, timeoutMs: 40 });
    return { ctx, outcome, telemetry };
  }

  it("collects the ids that were recorded, and no others", async () => {
    const ctx = await runSigned(makeAgentEvent(), world, { forgeCourier: true });
    const ids = collectEvidenceIds(ctx);

    expect(ids.has("C1")).toBe(true); // the credential failure really fired
    expect(ids.has("decision")).toBe(true);
    expect(ids.has("I7")).toBe(false); // this run has no mock-location flag
  });

  it("accepts an explanation that cites collected evidence", async () => {
    const { outcome, telemetry } = await explainWith(
      fixedProvider(
        "good",
        JSON.stringify({ summary: "The courier's signature did not verify.", citations: ["C1"] }),
      ),
      true,
    );

    expect(outcome.fromFallback).toBe(false);
    expect(outcome.explanation).toMatch(/did not verify/);
    expect(telemetry.explain.accepted).toBe(1);
  });

  /**
   * FAIL CLOSED, AND WHOLE. The response below carries one real citation and
   * one invented one. Keeping the summary because part of it checked out is how
   * an invented claim acquires the authority of a sourced one.
   */
  it("rejects the entire explanation when one citation was never collected", async () => {
    const { outcome, telemetry } = await explainWith(
      fixedProvider(
        "hallucinating",
        JSON.stringify({
          summary: "Location signals contradicted each other.",
          citations: ["C1", "I7"],
        }),
      ),
      true,
    );

    expect(outcome.fromFallback).toBe(true);
    expect(outcome.rejection).toBe("bad_citation");
    expect(outcome.hallucinatedCitations).toEqual(["I7"]);
    // Not a word of the model's prose survives.
    expect(outcome.explanation).not.toMatch(/contradicted each other/);
    expect(telemetry.explain.rejected.bad_citation).toBe(1);
  });

  it("falls back to a complete structured account, not an error message", async () => {
    const ctx = await runSigned(makeAgentEvent(), world, { forgeCourier: true });
    const fallback = structuredExplanation(ctx);

    expect(fallback).toMatch(/^Decision: freeze\./);
    expect(fallback).toMatch(/C1:/);
    expect(fallback).toMatch(/checks evaluable/);
  });

  it("falls back when the provider is unavailable", async () => {
    const { outcome, telemetry } = await explainWith(unreachableProvider());

    expect(outcome.fromFallback).toBe(true);
    expect(telemetry.explain.rejected.provider_error).toBe(1);
  });

  it("falls back on a schema-invalid response", async () => {
    const { outcome, telemetry } = await explainWith(
      schemaViolatingProvider({ summary: 42, citations: "none" }),
    );

    expect(outcome.fromFallback).toBe(true);
    expect(telemetry.explain.rejected.schema_invalid).toBe(1);
  });

  it("computes the coverage line once, from the Resolution, not from the model", async () => {
    const { ctx, outcome } = await explainWith(
      fixedProvider("good", JSON.stringify({ summary: "Ordinary handoff.", citations: [] })),
    );

    expect(outcome.explanation).toContain(ctx.coverage!.inconsistency!.line);
    // The model was never given the line to restate.
    expect(outcome.explanation.match(/checks evaluable/g)).toHaveLength(1);
  });
});

describe("prose may not contradict the sealed verdict", () => {
  it("catches a model calling a frozen handoff approved", () => {
    expect(findDecisionContradiction("This handoff was approved.", "freeze")).toBe("approved");
    expect(findDecisionContradiction("Everything is cleared.", "escalate")).toBe("cleared");
  });

  it("catches a model calling an accepted handoff rejected", () => {
    expect(findDecisionContradiction("The handoff was rejected.", "accept")).toBe("rejected");
  });

  /**
   * The asymmetry, tested: a negated form must NOT be refused, because refusing
   * a correct explanation costs the operator a readable page for nothing.
   */
  it("does not trip on a correctly negated sentence", () => {
    expect(findDecisionContradiction("This handoff was not approved.", "freeze")).toBeUndefined();
    expect(findDecisionContradiction("The parcel cannot be cleared yet.", "flag")).toBeUndefined();
  });

  it("rejects the explanation end to end and falls back", async () => {
    const ctx = await runSigned(makeAgentEvent(), world, { forgeCourier: true });
    const telemetry = createTelemetry();

    const outcome = await explainVerdict(ctx, {
      provider: fixedProvider(
        "contradicting",
        JSON.stringify({ summary: "Nothing to worry about; the delivery was approved.", citations: [] }),
      ),
      telemetry,
    });

    expect(ctx.verdict?.decision).toBe("freeze");
    expect(outcome.fromFallback).toBe(true);
    expect(outcome.rejection).toMatch(/decision_contradiction/);
    expect(telemetry.explain.rejected.decision_contradiction).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Telemetry — the number experiment 5 reports                                */
/* -------------------------------------------------------------------------- */

/**
 * Experiment 5 reports the hallucination rate BEFORE and AFTER enforcement, so
 * both numbers have to be observable. A log line cannot be totalled at the end
 * of a batch; these counters can, and they survive across a whole run.
 */
describe("rejections are counted, by reason, across a whole run", () => {
  it("accumulates across many calls rather than resetting", async () => {
    const ctx = await runSigned(makeAgentEvent(), world, { forgeCourier: true });
    const telemetry = createTelemetry();

    const hallucinating = fixedProvider(
      "h",
      JSON.stringify({ summary: "See the location conflict.", citations: ["I1"] }),
    );

    for (let i = 0; i < 5; i++) {
      await explainVerdict(ctx, { provider: hallucinating, telemetry });
    }

    expect(telemetry.explain.attempts).toBe(5);
    expect(telemetry.explain.rejected.bad_citation).toBe(5);
    expect(telemetry.explain.accepted).toBe(0);
    expect(rejectionRate(telemetry, "explain")).toBe(1);
  });

  it("distinguishes why each rejection happened", async () => {
    const ctx = await runSigned(makeAgentEvent(), world, { forgeCourier: true });
    const telemetry = createTelemetry();

    await explainVerdict(ctx, { provider: unreachableProvider(), telemetry });
    await explainVerdict(ctx, { provider: garbageProvider(), telemetry });
    await explainVerdict(ctx, {
      provider: fixedProvider("h", JSON.stringify({ summary: "x", citations: ["I9"] })),
      telemetry,
    });
    await explainVerdict(ctx, {
      provider: fixedProvider("c", JSON.stringify({ summary: "It was approved.", citations: [] })),
      telemetry,
    });

    // Four failures, four different reasons. Experiment 5 needs the breakdown,
    // not a single total.
    expect(telemetry.explain.rejected).toEqual({
      provider_error: 1,
      schema_invalid: 1,
      bad_citation: 1,
      decision_contradiction: 1,
      unknown_tool: 0,
    });
    expect(totalRejected(telemetry, "explain")).toBe(4);
  });

  it("reports a zero rate when nothing has been asked", () => {
    expect(rejectionRate(createTelemetry(), "explain")).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The verdict is already sealed before any of this runs                      */
/* -------------------------------------------------------------------------- */

/**
 * `explain` is node 8; the verdict seals at node 7. A failure here can only
 * cost the operator prose — which is the design working, and is worth seeing
 * as a test rather than inferring from the node order.
 */
describe("an explain failure leaves the sealed verdict untouched", () => {
  it("keeps the verdict, the ledger chain and the projection intact", async () => {
    const event = makeAgentEvent();

    const ctx = await runAgent(event, withLlm({ provider: unreachableProvider() }), {
      credential: world.credentialFor(event, { cosign: true }),
    });

    expect(ctx.decision).toBe("accept");
    expect(ctx.verdict).toBeDefined();
    expect(ctx.explanationFromFallback).toBe(true);

    // The ledger sealed before explain ran, and is unaffected by its failure.
    expect(world.deps.ledger.verifyChain()).toEqual({ valid: true, entries: 1 });

    const row = world.deps.db
      .select()
      .from(verdicts)
      .where(eq(verdicts.eventId, ctx.event!.eventID))
      .get();
    expect(row?.decision).toBe("accept");
    // The structured account was still written; it is a real explanation.
    expect(row?.explanation).toMatch(/^Decision: accept\./);
  });

  it("seals the same verdict whether the explanation succeeded or failed", async () => {
    const event = makeAgentEvent();

    const failed = await runAgent(event, withLlm({ provider: unreachableProvider() }), {
      credential: world.credentialFor(event, { cosign: true }),
    });

    const other = seedWorld();
    try {
      const succeeded = await runAgent(
        event,
        {
          ...other.deps,
          llm: {
            provider: scriptedProvider("ok", {
              plan: { tools: [] },
              explain: { summary: "An ordinary handoff.", citations: [] },
            }),
          },
        },
        { credential: other.credentialFor(event, { cosign: true }) },
      );

      expect(succeeded.explanationFromFallback).toBe(false);
      expect(JSON.stringify(succeeded.verdict)).toBe(JSON.stringify(failed.verdict));
    } finally {
      rmSync(other.dir, { recursive: true, force: true });
    }
  });
});

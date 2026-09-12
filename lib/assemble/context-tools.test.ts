import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { COURIER_ID, EPC, makeAgentEvent, runSigned, seedWorld } from "@/lib/agent/fixtures";
import { collectEvidenceIds } from "@/lib/llm/explain";
import { checkAddressHistory, fetchRouteHistory, lookupRecipientHistory } from "./context-tools";
import type { AgentContext } from "@/lib/agent/context";

/**
 * THE ASSERTION WHOSE ABSENCE LET TWO STUBS SURVIVE.
 *
 * `fetch_route_history` and `lookup_recipient_history` were in the closed enum,
 * in the deterministic heuristic and in the prompt the model reads, with no
 * implementation behind either. Selecting one did nothing, and every test
 * passed — because the parity tests assert that the verdict does NOT change
 * when tools change, which is the opposite property and is equally satisfied by
 * a tool that does nothing at all.
 *
 * So this file asserts the thing nobody had: selecting a tool has an effect.
 * See CLAUDE.md rule 1g, defect 6.
 */

describe("a selected tool produces a real result", () => {
  it("reads the courier's actual recent handoffs", async () => {
    const world = seedWorld();
    try {
      // Seal one handoff so there is history to find.
      await runSigned(makeAgentEvent(), world);

      const later = new Date(Date.parse(world.deps.now().toISOString()) + 3_600_000).toISOString();
      const result = fetchRouteHistory(world.deps.db, COURIER_ID, later);

      expect(result.tool).toBe("fetch_route_history");
      expect(result.found).toBe(true);
      expect(Number(result.detail.handoffs)).toBeGreaterThan(0);
      // The summary is built from counted rows, never from prose.
      expect(result.summary).toMatch(/\d+ earlier handoffs/);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  it("reports an empty history as a finding rather than as nothing", () => {
    const world = seedWorld();
    try {
      const result = fetchRouteHistory(world.deps.db, "CR-NOBODY", world.deps.now().toISOString());

      expect(result.found).toBe(false);
      expect(result.summary).toMatch(/No earlier handoffs/);
      // An absent entry would be indistinguishable from a tool never asked.
      expect(result.detail.handoffs).toBe(0);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  it("answers the recipient and address lookups from real rows", () => {
    const world = seedWorld();
    try {
      const now = world.deps.now().toISOString();
      const epc = EPC;

      const recipient = lookupRecipientHistory(world.deps.db, epc, now);
      const address = checkAddressHistory(world.deps.db, epc, now);

      expect(recipient.tool).toBe("lookup_recipient_history");
      expect(address.tool).toBe("check_address_history");
      // Both must say something concrete either way, never return an empty shell.
      expect(recipient.summary.length).toBeGreaterThan(10);
      expect(address.summary.length).toBeGreaterThan(10);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });
});

/**
 * A tool that found nothing must not become citable.
 *
 * "The recipient has no dispute history" is a claim about evidence we looked
 * for and did not find. Letting a model attach a citation id to it would dress
 * an absence as a record — the same failure as citing a rule that never fired.
 */
describe("only a tool that found something is citable", () => {
  function ctxWith(results: AgentContext["toolResults"]): AgentContext {
    return { input: {}, trace: [], toolResults: results } as unknown as AgentContext;
  }

  it("adds the tool id when it found something", () => {
    const ids = collectEvidenceIds(
      ctxWith([
        { tool: "fetch_route_history", found: true, summary: "s", detail: { handoffs: 3 } },
      ]),
    );

    expect(ids.has("fetch_route_history")).toBe(true);
  });

  it("withholds the id when the lookup came back empty", () => {
    const ids = collectEvidenceIds(
      ctxWith([
        { tool: "lookup_recipient_history", found: false, summary: "none", detail: {} },
      ]),
    );

    expect(ids.has("lookup_recipient_history")).toBe(false);
  });
});

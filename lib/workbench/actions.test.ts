import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalHash } from "@/lib/ledger";
import { handoffCases, verdicts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createWorkbench, type OperatorWorkbench } from "./service";
import { OperatorActionName } from "./types";

/**
 * NO OPERATOR ACTION MAY MUTATE A SEALED VERDICT.
 *
 * WHY THIS TEST HAS A DIFFERENT SHAPE FOR `approve` THAN FOR THE OTHER FOUR,
 * which is the whole reason it exists in this form:
 *
 *   "APPENDS A SECOND RUN" AND "REWROTE THE FIRST" ARE INDISTINGUISHABLE TO A
 *   SUITE THAT ONLY COUNTS ROWS OR ONLY CHECKS THE NON-WRITING ACTIONS.
 *
 * That is the class of hole that never produces an error. `approve` is the only
 * action that legitimately writes — it reruns the byte-identical event through
 * `runAgent` with a completed sidecar credential, which seals a second ledger
 * entry and projects a second verdict row. Session 17A asserted only that a
 * `reject` left the rows alone, so four of the five enum members were unguarded
 * and the one that writes was the one nobody was watching.
 *
 * So the assertions differ on purpose:
 *
 *   the four non-sealing actions  every verdict row is byte-identical afterwards
 *   `approve`                     every PRE-EXISTING row is byte-identical, and
 *                                 the only permitted delta is ADDED rows, each
 *                                 carrying the same event hash as run 1
 *
 * A future session that adds a sixth action is caught by the coverage assertion
 * at the bottom, and a future session that reaches for `.update(verdicts)` is
 * caught structurally in `lib/purity.test.ts`. This test knows about today's
 * actions; that one does not need to.
 */

type Row = typeof verdicts.$inferSelect;

describe("no operator action mutates a sealed verdict", () => {
  let workbench: OperatorWorkbench;

  /** Which enum members this file actually exercised. */
  const covered = new Set<string>();

  beforeAll(async () => {
    workbench = await createWorkbench({ scenarioIds: ["S0", "S1", "S3", "S4", "S5", "S6"] });
  }, 60_000);

  afterAll(() => workbench.close());

  /** Every verdict row in the harness that owns this handoff, keyed by id. */
  function verdictRows(eventId: string): Map<string, Row> {
    const { db } = workbench.debugHandle(eventId);
    return new Map(db.select().from(verdicts).all().map((row) => [row.verdictId, row]));
  }

  function caseRow(eventId: string) {
    const { db } = workbench.debugHandle(eventId);
    const detail = workbench.getHandoff(eventId)!;
    return db
      .select()
      .from(handoffCases)
      .where(eq(handoffCases.eventId, detail.summary.eventId))
      .get();
  }

  function pick(predicate: (item: ReturnType<OperatorWorkbench["listQueue"]>[number]) => boolean) {
    const item = workbench.listQueue().find(predicate);
    if (!item) throw new Error("no queue item matched; the seeded workbench changed shape");
    return item;
  }

  /**
   * The four actions that decide something operationally and seal nothing.
   *
   * `request_evidence` moves a case to `awaiting_evidence`, which is not
   * terminal, so it and `reject` can run against the same case in sequence —
   * which is also how an operator would really use them.
   */
  it("leaves every verdict row byte-identical for the four non-sealing actions", async () => {
    const cases: { action: "request_evidence" | "reject" | "escalate"; eventId: string }[] = [];

    const flagged = pick((item) => item.state === "flagged" && item.scenarioId === "S4");
    const other = pick((item) => item.state === "flagged" && item.scenarioId === "S3");

    cases.push({ action: "request_evidence", eventId: flagged.eventId });
    cases.push({ action: "reject", eventId: flagged.eventId });
    cases.push({ action: "escalate", eventId: other.eventId });

    for (const { action, eventId } of cases) {
      const before = verdictRows(eventId);
      await workbench.resolveHandoff(eventId, { action });
      const after = verdictRows(eventId);

      expect([...after.keys()].sort(), `${action} changed which verdict rows exist`).toEqual(
        [...before.keys()].sort(),
      );
      for (const [id, row] of before) {
        expect(after.get(id), `${action} rewrote verdict row ${id}`).toEqual(row);
      }
      covered.add(action);
    }
  });

  /**
   * `propose_reroute` has NO reachable success path in the seeded workbench —
   * no scenario currently yields `reroute.status === "proposed"`. That is worth
   * asserting rather than skipping: a guard that throws must throw BEFORE it
   * writes anything, or the refusal leaves a half-applied action behind.
   */
  it("writes nothing at all when propose_reroute is refused", async () => {
    const item = pick((entry) => entry.state === "timed_out");
    const before = verdictRows(item.eventId);
    const caseBefore = caseRow(item.eventId);
    const actionsBefore = workbench.getHandoff(item.eventId)!.actions.length;

    await expect(workbench.resolveHandoff(item.eventId, { action: "propose_reroute" })).rejects.toThrow(
      /no authorised reroute/i,
    );

    const after = verdictRows(item.eventId);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [id, row] of before) expect(after.get(id)).toEqual(row);

    // The refusal must not have advanced the case or logged an action either.
    expect(caseRow(item.eventId)).toEqual(caseBefore);
    expect(workbench.getHandoff(item.eventId)!.actions).toHaveLength(actionsBefore);
    covered.add("propose_reroute");
  });

  /**
   * `approve` is the one action that writes, so it gets the stronger assertion.
   *
   * It must APPEND. Every row that existed before the co-signature must survive
   * byte-identical, and anything new must belong to the same event — the second
   * run is the same bytes with a completed credential, not a different handoff
   * and not a rewrite of the first attempt.
   */
  it("appends a second run on approve and rewrites nothing that was already there", async () => {
    const pending = pick((item) => item.state === "awaiting_cosignature");
    const before = verdictRows(pending.eventId);
    const detailBefore = workbench.getHandoff(pending.eventId)!;
    const eventHash = canonicalHash(detailBefore.event);

    const after = await workbench.resolveHandoff(pending.eventId, { action: "approve" });
    const rows = verdictRows(pending.eventId);

    // 1. Nothing that existed before was touched.
    for (const [id, row] of before) {
      expect(rows.get(id), `approve rewrote pre-existing verdict row ${id}`).toEqual(row);
    }

    // 2. The only permitted delta is addition.
    const added = [...rows.keys()].filter((id) => !before.has(id));
    expect(rows.size).toBe(before.size + added.length);
    expect(added.length, "approve sealed nothing; the completed credential did not take").toBe(1);

    // 3. What was added belongs to THIS event, sealed from the same bytes.
    expect(rows.get(added[0])!.eventId).toBe(detailBefore.summary.eventId);
    expect(after.runs).toHaveLength(2);
    expect(after.runs.map((run) => run.eventHash)).toEqual([eventHash, eventHash]);
    expect(after.summary.sealed).toBe(true);

    covered.add("approve");
  });

  /**
   * The enum is the source of truth for what an operator can do. If a future
   * session adds a sixth action, this fails until it is covered above — the
   * table cannot silently fall behind the thing it is meant to cover.
   */
  it("covers every member of the operator action enum", () => {
    expect([...covered].sort()).toEqual([...OperatorActionName.options].sort());
  });
});

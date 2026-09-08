import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { NonceLedger } from "@/lib/ledger";
import { mandates } from "@/lib/db/schema";
import { NODES } from "./context";
import {
  COURIER_ID,
  EPC,
  type World,
  makeAgentEvent,
  resetEventIds,
  runSigned,
  seedWorld,
  signalsOf,
} from "./fixtures";
import type { NodeDeps } from "./nodes";

let world: World;
let deps: NodeDeps;

beforeEach(() => {
  resetEventIds();
  world = seedWorld();
  deps = world.deps;
});

afterEach(() => rmSync(world.dir, { recursive: true, force: true }));

describe("pipeline", () => {
  it("runs all eight nodes in order and seals a verdict in the ledger", () => {
    const ctx = runSigned(makeAgentEvent(), world);

    expect(ctx.halted).toBeUndefined();
    expect(
      ctx.trace.filter((f) => f.type === "tool_start").map((f) => f.node),
    ).toEqual([...NODES]);
    expect(ctx.verdict).toBeDefined();
    expect(ctx.ledger).toEqual({ status: "recorded", seq: 0 });
    expect(deps.ledger.verifyChain()).toEqual({ valid: true, entries: 1 });
  });

  it("accepts a clean delivery from a known courier", () => {
    const ctx = runSigned(makeAgentEvent(), world);

    expect(ctx.decision).toBe("accept");
    expect(ctx.verdict?.inconsistencyScore).toBe(0);
    expect(ctx.requiresCosign).toBe(true); // cold start: no history yet
    expect(ctx.verdict?.basis).toBe("single_event_only");
  });
});

describe("parse", () => {
  it("halts on an event that does not validate, rather than guessing", () => {
    const ctx = runSigned(makeAgentEvent({ eventTime: "2026-09-08T10:15:00" }), world);

    expect(ctx.halted).toEqual({ at: "parse", reason: "EVENT_SCHEMA_INVALID" });
    expect(ctx.parseError).toMatch(/eventTime/);
    expect(ctx.verdict).toBeUndefined();
    expect(deps.ledger.readRecords()).toHaveLength(0);
  });

  it("stamps recordTime from the server clock when the device omits it", () => {
    const ctx = runSigned(makeAgentEvent(), world);

    expect(ctx.event?.recordTime).toBe(deps.now().toISOString());
    expect(ctx.recordTimeSuppliedByClient).toBeUndefined();
  });

  it("notes when a device supplies a recordTime it has no business authoring", () => {
    const ctx = runSigned(makeAgentEvent({ recordTime: "2026-09-08T10:15:01+08:00" }), world);
    expect(ctx.recordTimeSuppliedByClient).toBe(true);
  });
});

describe("lookup", () => {
  it("resolves a known parcel, courier and active mandate", () => {
    const ctx = runSigned(makeAgentEvent(), world);

    expect(ctx.parcel).toMatchObject({ epc: EPC, known: true });
    expect(ctx.parcel?.recipientPoint).toEqual({ latitude: 3.1595, longitude: 101.7123 });
    expect(ctx.courier).toMatchObject({ courierId: COURIER_ID, known: true });
    expect(ctx.mandate?.known).toBe(true);
    expect(ctx.mandate?.value?.mandateId).toBe("MD-0001");
    expect(ctx.unknownEntityRisk).toBeUndefined();
  });

  it("reads coordinates back as REAL numbers, not truncated integers", () => {
    // Guards the schema fix: an integer column would hand back 3, not 3.1595.
    const ctx = runSigned(makeAgentEvent(), world);
    expect(ctx.parcel?.recipientPoint?.latitude).toBeCloseTo(3.1595, 4);
    expect(Number.isInteger(ctx.parcel?.recipientPoint?.latitude)).toBe(false);
  });

  it("marks an unissued EPC as high risk instead of treating it as neutral", () => {
    const ctx = runSigned(makeAgentEvent({ epcList: ["urn:epc:id:sgtin:0614141.107346.0000"] }), world);

    expect(ctx.parcel?.known).toBe(false);
    expect(ctx.unknownEntityRisk).toBe("high");
  });

  it("marks an unknown courier as high risk", () => {
    const ctx = runSigned(makeAgentEvent({ "vigil:courierId": "CR-9999" }), world);

    expect(ctx.courier?.known).toBe(false);
    expect(ctx.unknownEntityRisk).toBe("high");
  });

  it("marks an event that claims no courier at all as high risk", () => {
    const ctx = runSigned(makeAgentEvent({ "vigil:courierId": undefined }), world);
    expect(ctx.unknownEntityRisk).toBe("high");
  });

  /**
   * Unreadable authorisation is treated as NO authorisation. A mandate whose
   * JSON will not parse must never be interpreted generously — H2 then refuses
   * the handoff, which is the right answer to "we cannot read what this courier
   * is permitted to do". See CLAUDE.md.
   */
  it("treats a mandate with malformed JSON as no mandate, and refuses the handoff", () => {
    deps.db.update(mandates).set({ scopeJson: "{not json" }).run();

    const ctx = runSigned(makeAgentEvent(), world);

    expect(ctx.mandate?.known).toBe(false);
    expect(ctx.mandate?.value).toBeUndefined();
    expect(ctx.resolution.missing.map((m) => m.reason).join(" ")).toMatch(/malformed JSON/);
    // H2 fails: an unscoped actor is not an actor with unlimited scope.
    expect(ctx.verdict?.abortCode).toBe("H2");
    expect(ctx.decision).toBe("freeze");
  });

  it("treats a schema-invalid mandate the same way", () => {
    deps.db.update(mandates).set({ limitsJson: '{"maxHandoffsPerShift":"lots"}' }).run();

    const ctx = runSigned(makeAgentEvent(), world);

    expect(ctx.mandate?.known).toBe(false);
    expect(ctx.resolution.missing.map((m) => m.reason).join(" ")).toMatch(/does not satisfy the schema/);
    expect(ctx.decision).toBe("freeze");
  });
});

describe("verify - the ledger check (H4)", () => {
  it("replays the original verdict on a byte-equivalent retry, and halts", () => {
    const event = makeAgentEvent();
    const first = runSigned(event, world);
    const retry = runSigned(event, world);

    expect(retry.halted).toEqual({ at: "verify", reason: "DUPLICATE_NO_OP" });
    expect(retry.verdict).toEqual(first.verdict);
    expect(deps.ledger.readRecords()).toHaveLength(1);
  });

  it("aborts with EVENT_ID_REUSE when the same eventID carries different content", () => {
    const event = makeAgentEvent();
    runSigned(event, world);

    const forged = runSigned({ ...event, epcList: ["urn:epc:id:sgtin:0614141.107346.9999"] }, world);

    expect(forged.halted).toEqual({ at: "verify", reason: "EVENT_ID_REUSE" });
    expect(forged.decision).toBe("freeze");
    expect(forged.inconsistency?.flags.map((f) => f.id)).toEqual(["H4"]);
    expect(deps.ledger.readRecords().map((r) => r.kind)).toEqual(["verdict", "abort"]);
  });

  it("still catches the replay after a restart, rebuilding from the file alone", () => {
    const event = makeAgentEvent();
    runSigned(event, world);

    const reopened: NodeDeps = { ...deps, ledger: new NonceLedger(deps.ledger.path) };
    const retry = runSigned(event, world, { deps: reopened });

    expect(retry.halted).toEqual({ at: "verify", reason: "DUPLICATE_NO_OP" });
  });
});

describe("the two axes", () => {
  it("keeps inconsistency and pattern as separate fields and never sums them", () => {
    const ctx = runSigned(makeAgentEvent(), world);

    expect(ctx.verdict).toMatchObject({ inconsistencyScore: 0, patternScore: 0 });
    expect(ctx.engineResult).toBeDefined();
    expect(ctx.patternOutcome).toBeDefined();
  });

  it("produces axis 1 at verify and axis 2 at fetch_history, meeting only at gate", () => {
    const order: string[] = [];
    const ctx = runSigned(makeAgentEvent(), world, {
      runOptions: {
        onTrace: (f) => {
          if (f.type !== "tool_end") return;
          if (["verify", "fetch_history", "gate"].includes(f.node)) order.push(f.node);
        },
      },
    });

    expect(order).toEqual(["verify", "fetch_history", "gate"]);
    expect(ctx.decision).toBeDefined();
  });

  it("reports evidence coverage for each axis from the engines' own counts", () => {
    const ctx = runSigned(makeAgentEvent(), world);

    expect(ctx.coverage?.inconsistency?.total).toBe(14);
    expect(ctx.coverage?.inconsistency?.line).toMatch(/^\d+ of 14 checks evaluable$/);
    expect(ctx.coverage?.pattern?.total).toBe(5);
  });
});

/* -------------------------------------------------------------------------- */
/* The LLM parity claim                                                       */
/* -------------------------------------------------------------------------- */

/**
 * "REMOVE THE LLM AND THE VERDICTS ARE IDENTICAL" IS A TEST, NOT A PROMISE.
 *
 * The sealed verdict must be byte-identical with no LLM at all, and with two
 * different fake models that disagree with each other about tool selection and
 * about how to describe what happened. Only the prose may differ.
 *
 * If a future session ever needs to relax this, the architecture has already
 * broken — the LLM has acquired influence over an outcome it must never touch.
 * See CLAUDE.md.
 */
describe("removing the LLM produces identical verdicts", () => {
  const fakeA = {
    planTools: () => ({ tools: ["check_traffic_weather"], rationale: "A: check the weather" }),
    explain: () => "A: this delivery looks fine to me.",
  };

  const fakeB = {
    planTools: () => ({ tools: ["lookup_recipient_history"], rationale: "B: check the recipient" }),
    explain: () => "B: I would escalate this, personally.",
  };

  /** One fresh world per run, so each starts from identical state. */
  const runWith = (llm?: NodeDeps["llm"]) => {
    resetEventIds();
    const w = seedWorld();
    const ctx = runSigned(makeAgentEvent(), w, { deps: { ...w.deps, llm } });
    rmSync(w.dir, { recursive: true, force: true });
    return ctx;
  };

  it("seals the same verdict with no LLM, with fake A, and with fake B", () => {
    const none = runWith(undefined);
    const a = runWith(fakeA);
    const b = runWith(fakeB);

    const sealed = (c: typeof none) => JSON.stringify(c.verdict);

    expect(sealed(a)).toBe(sealed(none));
    expect(sealed(b)).toBe(sealed(none));
    expect(none.verdict).toBeDefined();
  });

  it("seals the same verdict on an event that is NOT clean", () => {
    // A mock-location spoof: the verdict must be identical regardless of what
    // any model says about it.
    const spoofed = () => {
      resetEventIds();
      const w = seedWorld();
      const event = makeAgentEvent();
      const signals = signalsOf(event);
      (signals.gps as { mockLocationProvider: boolean }).mockLocationProvider = true;
      return { w, event };
    };

    const results = [undefined, fakeA, fakeB].map((llm) => {
      const { w, event } = spoofed();
      const ctx = runSigned(event, w, { deps: { ...w.deps, llm } });
      rmSync(w.dir, { recursive: true, force: true });
      return ctx;
    });

    expect(results[0].verdict?.flags).toContain("I7");
    expect(JSON.stringify(results[1].verdict)).toBe(JSON.stringify(results[0].verdict));
    expect(JSON.stringify(results[2].verdict)).toBe(JSON.stringify(results[0].verdict));
  });

  it("lets only the prose differ", () => {
    const none = runWith(undefined);
    const a = runWith(fakeA);
    const b = runWith(fakeB);

    expect(a.explanation).not.toBe(none.explanation);
    expect(b.explanation).not.toBe(a.explanation);
    expect(a.decision).toBe(none.decision);
    expect(b.decision).toBe(none.decision);
  });

  it("records whether the plan came from the model or the deterministic heuristic", () => {
    expect(runWith(undefined).planFromHeuristic).toBe(true);
    expect(runWith(fakeA).planFromHeuristic).toBe(false);
  });
});

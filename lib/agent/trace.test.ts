import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { NODES } from "./context";
import { TraceFrame, toSseMessage } from "./trace";
import {
  type World,
  makeAgentEvent,
  resetEventIds,
  runSigned,
  seedWorld,
  signalsOf,
} from "./fixtures";

/**
 * The SSE contract. Frozen from session 4 — the operator console is built
 * against this shape, so these tests are what stops it moving underneath.
 */

let world: World;

beforeEach(() => {
  resetEventIds();
  world = seedWorld();
});
afterEach(() => rmSync(world.dir, { recursive: true, force: true }));

/** A clock that advances on every read, so durations are non-zero. */
function tickingWorld() {
  const w = seedWorld();
  let t = Date.parse("2026-09-08T02:15:30.000Z");
  return { ...w, deps: { ...w.deps, now: () => new Date((t += 3)) } };
}

describe("frame shape", () => {
  it("emits only the four contract types", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    const types = new Set(ctx.trace.map((f) => f.type));

    expect([...types].sort()).toEqual(["result", "tool_end", "tool_start"]);
    for (const frame of ctx.trace) {
      expect(["tool_start", "tool_end", "thought", "result"]).toContain(frame.type);
    }
  });

  it("validates every frame against the schema on the way out", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    for (const frame of ctx.trace) {
      expect(TraceFrame.safeParse(frame).success).toBe(true);
    }
  });

  it("pairs a tool_start with a tool_end for every node", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);

    const starts = ctx.trace.filter((f) => f.type === "tool_start").map((f) => f.node);
    const ends = ctx.trace.filter((f) => f.type === "tool_end").map((f) => f.node);

    expect(starts).toEqual([...NODES]);
    expect(ends).toEqual([...NODES]);
  });

  it("emits exactly one result frame, and emits it last", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    const results = ctx.trace.filter((f) => f.type === "result");

    expect(results).toHaveLength(1);
    expect(ctx.trace.at(-1)?.type).toBe("result");
  });
});

describe("ordering and timing", () => {
  it("numbers frames monotonically from zero", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    expect(ctx.trace.map((f) => f.seq)).toEqual(ctx.trace.map((_, i) => i));
  });

  it("never moves time backwards", async () => {
    const w = tickingWorld();
    try {
      const ctx = await runSigned(makeAgentEvent(), w);
      const times = ctx.trace.map((f) => Date.parse(f.at));
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
      }
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("reports a duration on every tool_end", async () => {
    const w = tickingWorld();
    try {
      const ctx = await runSigned(makeAgentEvent(), w);
      const ends = ctx.trace.filter((f) => f.type === "tool_end");

      expect(ends).toHaveLength(NODES.length);
      for (const end of ends) expect(end.durationMs).toBeGreaterThan(0);
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("streams frames to the consumer in the same order they are recorded", async () => {
    const streamed: number[] = [];
    const ctx = await runSigned(makeAgentEvent(), world, {
      runOptions: { onTrace: (f) => streamed.push(f.seq) },
    });

    expect(streamed).toEqual(ctx.trace.map((f) => f.seq));
  });
});

describe("what the frames carry", () => {
  it("carries the flags produced by verify and fetch_history", async () => {
    // A mock-location spoof, so verify has something to report.
    const event = makeAgentEvent();
    const signals = signalsOf(event);
    (signals.gps as { mockLocationProvider: boolean }).mockLocationProvider = true;

    const ctx = await runSigned(event, world);
    const verify = ctx.trace.find((f) => f.type === "tool_end" && f.node === "verify");
    const history = ctx.trace.find((f) => f.type === "tool_end" && f.node === "fetch_history");

    expect(verify?.type === "tool_end" && verify.summary?.flags).toContain("I7");
    expect(verify?.type === "tool_end" && verify.summary?.score).toBe(50);
    expect(history?.type === "tool_end" && history.summary?.flags).toEqual([]);
  });

  it("carries the evidence-coverage line on both scoring nodes", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);

    const verify = ctx.trace.find((f) => f.type === "tool_end" && f.node === "verify");
    expect(verify?.type === "tool_end" && verify.summary?.coverage?.total).toBe(14);
    expect(verify?.type === "tool_end" && verify.summary?.coverage?.line).toMatch(
      /^\d+ of 14 checks evaluable$/,
    );

    const history = ctx.trace.find((f) => f.type === "tool_end" && f.node === "fetch_history");
    expect(history?.type === "tool_end" && history.summary?.coverage?.total).toBe(5);
  });

  it("keeps the two axis scores as separate fields on the result frame", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    const result = ctx.trace.at(-1);

    expect(result?.type).toBe("result");
    if (result?.type !== "result") return;
    expect(result).toHaveProperty("inconsistencyScore");
    expect(result).toHaveProperty("patternScore");
    // No combined field for a client to read instead.
    expect(result).not.toHaveProperty("totalScore");
    expect(result).not.toHaveProperty("riskScore");
  });

  it("reports the gate's cell, co-sign state and ledger sequence", async () => {
    const ctx = await runSigned(makeAgentEvent(), world);
    const gate = ctx.trace.find((f) => f.type === "tool_end" && f.node === "gate");

    expect(gate?.type === "tool_end" && gate.summary?.detail).toMatchObject({
      decision: "accept",
      requiresCosign: true,
      ledgerSeq: 0,
    });
  });
});

describe("halted runs still produce a contract-shaped stream", () => {
  it("emits a result frame naming where it stopped", async () => {
    const ctx = await runSigned(makeAgentEvent({ eventTime: "not-a-time" }), world);
    const result = ctx.trace.at(-1);

    expect(result?.type).toBe("result");
    if (result?.type !== "result") return;
    expect(result.halted).toEqual({ at: "parse", reason: "EVENT_SCHEMA_INVALID" });
    expect(result.decision).toBeUndefined();
  });

  it("stops emitting tool frames after the halt", async () => {
    const ctx = await runSigned(makeAgentEvent({ eventTime: "not-a-time" }), world);
    const nodes = ctx.trace.filter((f) => f.type === "tool_start").map((f) => f.node);

    expect(nodes).toEqual(["parse"]);
  });

  it("reports the replayed verdict on a duplicate", async () => {
    const event = makeAgentEvent();
    await runSigned(event, world);
    const retry = await runSigned(event, world);

    const result = retry.trace.at(-1);
    expect(result?.type === "result" && result.halted?.reason).toBe("DUPLICATE_NO_OP");
    expect(result?.type === "result" && result.decision).toBe("accept");
  });
});

describe("the wire format", () => {
  it("serialises a frame as a named SSE event", async () => {
    const frame = TraceFrame.parse({
      type: "tool_start",
      seq: 0,
      node: "parse",
      at: "2026-09-08T10:15:00+08:00",
    });

    const message = toSseMessage(frame);
    expect(message).toMatch(/^event: tool_start\n/);
    expect(message).toMatch(/\n\n$/);
    expect(JSON.parse(message.split("data: ")[1])).toEqual(frame);
  });

  it("rejects a frame that is not in the contract", async () => {
    expect(TraceFrame.safeParse({ type: "made_up", seq: 0, at: "2026-09-08T10:15:00+08:00" }).success).toBe(
      false,
    );
  });

  it("rejects a tool_start with an unknown node name", async () => {
    expect(
      TraceFrame.safeParse({
        type: "tool_start",
        seq: 0,
        node: "reticulate_splines",
        at: "2026-09-08T10:15:00+08:00",
      }).success,
    ).toBe(false);
  });

  it("accepts a thought frame, the only one an LLM will ever author", async () => {
    const parsed = TraceFrame.safeParse({
      type: "thought",
      seq: 3,
      node: "plan",
      at: "2026-09-08T10:15:00+08:00",
      text: "The route history might explain the stop.",
    });

    expect(parsed.success).toBe(true);
  });
});

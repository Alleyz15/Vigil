import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceLedger } from "@/lib/ledger";
import { createMigratedDb } from "@/lib/db/migrate";
import { couriers, mandates, parcels } from "@/lib/db/schema";
import { runAgent } from "./machine";
import { NODES } from "./context";
import type { NodeDeps } from "./nodes";

const EPC = "urn:epc:id:sgtin:0614141.107346.2017";
const COURIER = "CR-0042";

let dir: string;
let deps: NodeDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vigil-agent-"));
  const db = createMigratedDb(":memory:");

  db.insert(parcels)
    .values({
      epc: EPC,
      waybillNo: "WB-2026-000123",
      recipientName: "Nurul",
      recipientAddress: "Jalan Ampang, Kuala Lumpur",
      declaredValueSen: 12_000,
    })
    .run();

  db.insert(couriers)
    .values({ courierId: COURIER, displayName: "Courier 42", publicKey: "base64key", boundDeviceId: "HHT-0042" })
    .run();

  db.insert(mandates)
    .values({
      mandateId: "MD-0001",
      courierId: COURIER,
      preset: "standard",
      scopeJson: "{}",
      limitsJson: "{}",
      validityJson: "{}",
      requiresCosignIfJson: "[]",
    })
    .run();

  deps = {
    db,
    ledger: new NonceLedger(join(dir, "nonce-ledger.jsonl")),
    now: () => new Date("2026-09-08T10:20:00+08:00"),
  };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const event = (over: Record<string, unknown> = {}) => ({
  type: "ObjectEvent",
  eventID: "6f8c0d3e-4a1b-4c2d-9e5f-2b7a1c3d4e5f",
  eventTime: "2026-09-08T10:15:00+08:00",
  eventTimeZoneOffset: "+08:00",
  epcList: [EPC],
  action: "OBSERVE",
  bizStep: "urn:epcglobal:cbv:bizstep:delivering",
  "vigil:courierId": COURIER,
  ...over,
});

describe("pipeline", () => {
  it("runs all eight nodes in order and seals a verdict in the ledger", () => {
    const ctx = runAgent(event(), deps);

    expect(ctx.halted).toBeUndefined();
    expect(ctx.trace.filter((f) => f.phase === "start").map((f) => f.node)).toEqual([...NODES]);
    expect(ctx.verdict).toBeDefined();
    expect(ctx.ledger).toEqual({ status: "recorded", seq: 0 });
    expect(deps.ledger.verifyChain()).toEqual({ valid: true, entries: 1 });
  });

  it("streams a trace frame per node for the SSE console", () => {
    const frames: string[] = [];
    runAgent(event(), deps, { onTrace: (f) => frames.push(`${f.node}:${f.phase}`) });

    expect(frames[0]).toBe("parse:start");
    expect(frames).toContain("gate:end");
    expect(frames).toHaveLength(NODES.length * 2);
  });
});

describe("parse", () => {
  it("halts on an event that does not validate, rather than guessing", () => {
    const ctx = runAgent(event({ eventTime: "2026-09-08T10:15:00" }), deps);

    expect(ctx.halted).toEqual({ at: "parse", reason: "EVENT_SCHEMA_INVALID" });
    expect(ctx.parseError).toMatch(/eventTime/);
    expect(ctx.verdict).toBeUndefined();
    expect(deps.ledger.readRecords()).toHaveLength(0);
  });

  it("stamps recordTime from the server clock when the device omits it", () => {
    const ctx = runAgent(event(), deps);

    expect(ctx.event?.recordTime).toBe(deps.now().toISOString());
    expect(ctx.recordTimeSuppliedByClient).toBeUndefined();
  });

  it("notes when a device supplies a recordTime it has no business authoring", () => {
    const ctx = runAgent(event({ recordTime: "2026-09-08T10:15:01+08:00" }), deps);
    expect(ctx.recordTimeSuppliedByClient).toBe(true);
  });
});

describe("lookup", () => {
  it("resolves a known parcel, courier and active mandate", () => {
    const ctx = runAgent(event(), deps);

    expect(ctx.parcel).toMatchObject({ epc: EPC, known: true });
    expect(ctx.courier).toMatchObject({ courierId: COURIER, known: true, boundDeviceId: "HHT-0042" });
    expect(ctx.mandate).toMatchObject({ mandateId: "MD-0001", known: true });
    expect(ctx.unknownEntityRisk).toBeUndefined();
  });

  it("marks an unissued EPC as high risk instead of treating it as neutral", () => {
    const ctx = runAgent(event({ epcList: ["urn:epc:id:sgtin:0614141.107346.0000"] }), deps);

    expect(ctx.parcel?.known).toBe(false);
    expect(ctx.unknownEntityRisk).toBe("high");
  });

  it("marks an unknown courier as high risk", () => {
    const ctx = runAgent(event({ "vigil:courierId": "CR-9999" }), deps);

    expect(ctx.courier?.known).toBe(false);
    expect(ctx.unknownEntityRisk).toBe("high");
  });

  it("marks an event that claims no courier at all as high risk", () => {
    const ctx = runAgent(event({ "vigil:courierId": undefined }), deps);
    expect(ctx.unknownEntityRisk).toBe("high");
  });

  it("does not report an active mandate for a courier who has none", () => {
    deps.db.delete(mandates).run();
    const ctx = runAgent(event(), deps);

    expect(ctx.courier?.known).toBe(true);
    expect(ctx.mandate?.known).toBe(false);
  });
});

describe("verify - the ledger check (H4)", () => {
  it("replays the original verdict on a byte-equivalent retry, and halts", () => {
    const first = runAgent(event(), deps);
    const retry = runAgent(event(), deps);

    expect(retry.halted).toEqual({ at: "verify", reason: "DUPLICATE_NO_OP" });
    expect(retry.verdict).toEqual(first.verdict);
    // One tap, one ledger line - the retry adds nothing.
    expect(deps.ledger.readRecords()).toHaveLength(1);
  });

  it("aborts with EVENT_ID_REUSE when the same eventID carries different content", () => {
    runAgent(event(), deps);
    const forged = runAgent(event({ epcList: ["urn:epc:id:sgtin:0614141.107346.9999"] }), deps);

    expect(forged.halted).toEqual({ at: "verify", reason: "EVENT_ID_REUSE" });
    expect(forged.decision).toBe("freeze");
    expect(forged.inconsistency?.flags.map((f) => f.code)).toEqual(["H4"]);
    // The rejected attempt is itself evidence, so it lands in the audit trail.
    expect(deps.ledger.readRecords().map((r) => r.kind)).toEqual(["verdict", "abort"]);
  });

  it("still catches the replay after a restart, rebuilding from the file alone", () => {
    runAgent(event(), deps);

    const reopened: NodeDeps = { ...deps, ledger: new NonceLedger(deps.ledger.path) };
    const retry = runAgent(event(), reopened, {});

    expect(retry.halted).toEqual({ at: "verify", reason: "DUPLICATE_NO_OP" });
  });
});

describe("the two axes", () => {
  it("keeps inconsistency and pattern as separate fields and never sums them", () => {
    const ctx = runAgent(event(), deps);

    expect(ctx.verdict).toMatchObject({ inconsistencyScore: 0, patternScore: 0 });
    expect(ctx.inconsistency).toBeDefined();
    expect(ctx.pattern).toBeDefined();
  });

  it("produces axis 1 at verify and axis 2 at fetch_history, meeting only at gate", () => {
    const order: string[] = [];
    const ctx = runAgent(event(), deps, {
      onTrace: (f) => {
        if (f.phase !== "end") return;
        if (f.node === "verify" || f.node === "fetch_history" || f.node === "gate") order.push(f.node);
      },
    });

    expect(order).toEqual(["verify", "fetch_history", "gate"]);
    expect(ctx.decision).toBeDefined();
  });
});

describe("LLM boundary", () => {
  it("selects tools from the closed enum only, and records that the plan was deterministic", () => {
    const ctx = runAgent(event(), deps);

    expect(ctx.plan?.tools).toEqual([]);
    expect(ctx.planFromHeuristic).toBe(true);
  });

  it("writes the explanation after the verdict is already sealed", () => {
    const ctx = runAgent(event(), deps);

    const gateEnd = ctx.trace.findIndex((f) => f.node === "gate" && f.phase === "end");
    const explainStart = ctx.trace.findIndex((f) => f.node === "explain" && f.phase === "start");
    expect(gateEnd).toBeLessThan(explainStart);
    expect(ctx.explanation).toBeTruthy();
  });
});

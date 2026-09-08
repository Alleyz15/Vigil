import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceLedger, entryHashOf } from "./ledger";
import { canonicalHash, canonicalize } from "./canonical";
import type { LedgerRecord, Verdict } from "./types";

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vigil-ledger-"));
  ledgerPath = join(dir, "nonce-ledger.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const EVENT_ID = "6f8c0d3e-4a1b-4c2d-9e5f-2b7a1c3d4e5f";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";
const SGTIN = "urn:epc:id:sgtin:0614141.107346.2017";
const OTHER_SGTIN = "urn:epc:id:sgtin:0614141.107346.9999";

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  decision: "accept",
  inconsistencyScore: 0,
  patternScore: 0,
  flags: [],
  ...over,
});

const payload = (over: Record<string, unknown> = {}) => ({
  type: "ObjectEvent",
  eventID: EVENT_ID,
  eventTime: "2026-09-08T10:15:00+08:00",
  epcList: [SGTIN],
  ...over,
});

describe("canonicalize", () => {
  it("is insensitive to key order, so a reordered retry is not a forgery", () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  it("is sensitive to array order, because array order carries meaning", () => {
    expect(canonicalHash({ a: [1, 2] })).not.toBe(canonicalHash({ a: [2, 1] }));
  });

  it("treats an absent key and an undefined key as the same payload", () => {
    expect(canonicalHash({ a: 1 })).toBe(canonicalHash({ a: 1, b: undefined }));
  });

  it("sorts nested keys too", () => {
    expect(canonicalize({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });
});

describe("path 1 - unseen eventID", () => {
  it("records the verdict and returns it", () => {
    const ledger = new NonceLedger(ledgerPath);
    const result = ledger.submit(EVENT_ID, payload(), () => verdict({ decision: "flag" }));

    expect(result.status).toBe("recorded");
    expect(result.status === "recorded" && result.verdict.decision).toBe("flag");
    expect(ledger.size).toBe(1);
  });
});

describe("path 2 - same eventID, same payload", () => {
  it("is a NO-OP that replays the original verdict, never a fraud alert", () => {
    const ledger = new NonceLedger(ledgerPath);
    ledger.submit(EVENT_ID, payload(), () => verdict({ decision: "flag", flags: ["I4"] }));

    // A retry from a dead spot: same content, different key order on the wire.
    const retry = ledger.submit(
      EVENT_ID,
      {
        epcList: [SGTIN],
        eventTime: "2026-09-08T10:15:00+08:00",
        eventID: EVENT_ID,
        type: "ObjectEvent",
      },
      () => {
        throw new Error("verdict must not be recomputed on a duplicate");
      },
    );

    expect(retry.status).toBe("noop");
    expect(retry.status === "noop" && retry.verdict.flags).toEqual(["I4"]);
    // No second ledger line: one tap, one record.
    expect(ledger.readRecords()).toHaveLength(1);
  });
});

describe("path 3 - same eventID, different payload", () => {
  it("aborts with EVENT_ID_REUSE", () => {
    const ledger = new NonceLedger(ledgerPath);
    ledger.submit(EVENT_ID, payload(), () => verdict());

    const forged = ledger.submit(EVENT_ID, payload({ epcList: [OTHER_SGTIN] }), () => {
      throw new Error("verdict must not be computed for a reused eventID");
    });

    expect(forged.status).toBe("aborted");
    expect(forged.status === "aborted" && forged.code).toBe("EVENT_ID_REUSE");
  });

  it("writes the failed attempt to the audit trail without rebinding the eventID", () => {
    const ledger = new NonceLedger(ledgerPath);
    ledger.submit(EVENT_ID, payload(), () => verdict({ decision: "accept" }));
    ledger.submit(EVENT_ID, payload({ epcList: [OTHER_SGTIN] }), () => verdict());

    const records = ledger.readRecords();
    expect(records.map((r) => r.kind)).toEqual(["verdict", "abort"]);
    // The original binding still stands, so a replay of the ORIGINAL is still a NO-OP.
    expect(ledger.lookup(EVENT_ID)?.decision).toBe("accept");
    expect(ledger.submit(EVENT_ID, payload(), () => verdict()).status).toBe("noop");
  });
});

describe("restart recovery", () => {
  it("rebuilds the registry from the file, so a replay after restart is still caught", () => {
    const first = new NonceLedger(ledgerPath);
    first.submit(EVENT_ID, payload(), () => verdict({ decision: "escalate", flags: ["P2"] }));

    // Process dies. Nothing survives but the file.
    const reopened = new NonceLedger(ledgerPath);

    expect(reopened.size).toBe(1);
    expect(reopened.lookup(EVENT_ID)?.decision).toBe("escalate");

    const retry = reopened.submit(EVENT_ID, payload(), () => {
      throw new Error("verdict must not be recomputed after restart");
    });
    expect(retry.status).toBe("noop");
    expect(retry.status === "noop" && retry.verdict.flags).toEqual(["P2"]);

    const forged = reopened.submit(EVENT_ID, payload({ epcList: [OTHER_SGTIN] }), () => verdict());
    expect(forged.status).toBe("aborted");
  });

  it("continues the hash chain across a restart rather than starting a new one", () => {
    const first = new NonceLedger(ledgerPath);
    first.submit(EVENT_ID, payload(), () => verdict());

    const reopened = new NonceLedger(ledgerPath);
    reopened.submit(OTHER_ID, payload({ eventID: OTHER_ID }), () => verdict());

    const records = reopened.readRecords();
    expect(records[1].prevHash).toBe(records[0].entryHash);
    expect(reopened.verifyChain()).toEqual({ valid: true, entries: 2 });
  });
});

describe("verifyChain", () => {
  const seed = (ledger: NonceLedger, n: number) => {
    for (let i = 0; i < n; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      ledger.submit(id, payload({ eventID: id }), () => verdict({ inconsistencyScore: i }));
    }
  };

  const readLines = () => readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
  const writeLines = (lines: string[]) => writeFileSync(ledgerPath, `${lines.join("\n")}\n`, "utf8");

  it("passes on an untouched ledger", () => {
    const ledger = new NonceLedger(ledgerPath);
    seed(ledger, 5);
    expect(ledger.verifyChain()).toEqual({ valid: true, entries: 5 });
  });

  it("breaks at the tampered index when a middle line is edited", () => {
    const ledger = new NonceLedger(ledgerPath);
    seed(ledger, 5);

    // Rewrite line index 2 - flip an escalation into an acceptance, the edit
    // someone with file access would actually want to make.
    const lines = readLines();
    const tampered = JSON.parse(lines[2]) as LedgerRecord;
    if (tampered.kind !== "verdict") throw new Error("fixture expected a verdict record");
    tampered.verdict.decision = "accept";
    tampered.verdict.inconsistencyScore = 0;
    lines[2] = JSON.stringify(tampered);
    writeLines(lines);

    const result = ledger.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.brokenAt).toBe(2);
    expect(result.valid === false && result.reason).toMatch(/entryHash/);
  });

  it("still breaks when the tamperer recomputes the edited line's own entryHash", () => {
    const ledger = new NonceLedger(ledgerPath);
    seed(ledger, 5);

    // A more careful attacker: edit line 2 AND reseal it. The chain still
    // catches it, because line 3's prevHash commits to the old value.
    const lines = readLines();
    const tampered = JSON.parse(lines[2]) as LedgerRecord;
    if (tampered.kind !== "verdict") throw new Error("fixture expected a verdict record");
    tampered.verdict.decision = "freeze";
    tampered.verdict.inconsistencyScore = 99;
    tampered.entryHash = entryHashOf(tampered);
    lines[2] = JSON.stringify(tampered);
    writeLines(lines);

    const result = ledger.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.brokenAt).toBe(3);
    expect(result.valid === false && result.reason).toMatch(/prevHash/);
  });

  it("breaks when a middle line is removed", () => {
    const ledger = new NonceLedger(ledgerPath);
    seed(ledger, 5);

    const lines = readLines();
    lines.splice(2, 1);
    writeLines(lines);

    const result = ledger.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.brokenAt).toBe(2);
    expect(result.valid === false && result.reason).toMatch(/seq/);
  });
});

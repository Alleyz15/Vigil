import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceLedger, entryHashOf } from "./ledger";
import { entryHashWeb, tamperWithCopy, verifyLedgerText } from "./browser-chain";
import type { LedgerRecord, Verdict } from "./types";

/**
 * The browser-side chain verifier.
 *
 * `crypto.subtle` exists in Node 24, so the code that will run in a visitor's
 * browser is exercised here directly rather than through a headless page. That
 * matters: a verifier only reachable by clicking a button in a demo is a
 * verifier nobody checks.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function ledgerWith(count: number): { path: string; ledger: NonceLedger } {
  const dir = mkdtempSync(join(tmpdir(), "vigil-chain-"));
  dirs.push(dir);
  const path = join(dir, "nonce-ledger.jsonl");
  const ledger = new NonceLedger(path);

  for (let i = 0; i < count; i++) {
    const verdict: Verdict = {
      decision: "accept",
      inconsistencyScore: 0,
      patternScore: 0,
      flags: [],
      basis: "both_axes",
      requiresCosign: false,
    };
    ledger.submit(`1111111${i}-2222-4333-8444-55555555555${i}`, { leg: i }, () => verdict);
  }

  return { path, ledger };
}

describe("one recipe, two digests", () => {
  /**
   * THE PIN. Node hashes with `node:crypto`, the browser with `crypto.subtle`,
   * and the two must agree byte for byte on real records. If they ever diverge
   * the page would confidently report a break in an intact chain — accusing the
   * artefact of exactly what it exists to disprove.
   */
  it("computes identical entry hashes in Node and via Web Crypto", async () => {
    const { path } = ledgerWith(4);
    const records = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerRecord);

    expect(records).toHaveLength(4);
    for (const record of records) {
      expect(await entryHashWeb(record)).toBe(entryHashOf(record));
    }
  });
});

describe("verifying an intact chain in the browser", () => {
  it("reports intact across every record", async () => {
    const { path, ledger } = ledgerWith(5);
    const text = readFileSync(path, "utf8");

    const result = await verifyLedgerText(text);

    expect(result).toMatchObject({ valid: true, entries: 5, records: 5 });
    // The page and the server must agree about the same file.
    expect(ledger.verifyChain()).toMatchObject({ valid: true, entries: 5 });
  });

  it("reports an empty ledger as intact across zero records", async () => {
    expect(await verifyLedgerText("")).toMatchObject({ valid: true, entries: 0, records: 0 });
  });
});

describe("demonstrating tampering on a copy", () => {
  /**
   * The index matters more than the boolean. "Something is wrong somewhere" is
   * an accusation; "record 2 no longer matches its own hash" is a finding.
   */
  it("names the index of the first altered record", async () => {
    const { path } = ledgerWith(5);
    const original = readFileSync(path, "utf8");

    for (const target of [0, 2, 4]) {
      const tampered = tamperWithCopy(original, target);
      const result = await verifyLedgerText(tampered);

      expect(result.valid).toBe(false);
      expect(result.valid === false && result.brokenAt).toBe(target);
    }
  });

  it("still verifies the untouched original afterwards", async () => {
    const { path } = ledgerWith(3);
    const original = readFileSync(path, "utf8");

    tamperWithCopy(original, 1);

    expect(await verifyLedgerText(original)).toMatchObject({ valid: true, entries: 3 });
  });

  /**
   * THE REAL LEDGER IS NEVER WRITTEN TO.
   *
   * A tamper demo with a write path back to the artefact would be a worse
   * defect than the one it illustrates, so this asserts the file's bytes AND
   * its modification time are unchanged after the demo runs.
   */
  it("never writes to the real ledger file", async () => {
    const { path } = ledgerWith(4);
    const before = readFileSync(path);
    const beforeMtime = statSync(path).mtimeMs;

    const tampered = tamperWithCopy(before.toString("utf8"), 2);
    const result = await verifyLedgerText(tampered);
    expect(result.valid).toBe(false);

    expect(readFileSync(path).equals(before)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(beforeMtime);
  });

  it("leaves the text alone when asked to tamper outside the file", () => {
    const { path } = ledgerWith(2);
    const original = readFileSync(path, "utf8");

    expect(tamperWithCopy(original, 9)).toBe(original);
    expect(tamperWithCopy(original, -1)).toBe(original);
  });
});

describe("a ledger that will not parse", () => {
  it("reports the offending line rather than discarding it", async () => {
    const { path } = ledgerWith(3);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    lines[1] = "{ not json";

    const result = await verifyLedgerText(`${lines.join("\n")}\n`);

    expect(result.valid).toBe(false);
    expect(result.valid === false && result.brokenAt).toBe(1);
    expect(result.valid === false && result.reason).toMatch(/not valid JSON/);
  });
});

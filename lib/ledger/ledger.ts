import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalHash, sha256Hex } from "./canonical";
import {
  type AbortRecord,
  type ChainVerification,
  type CheckResult,
  GENESIS_PREV_HASH,
  LedgerRecord,
  type SubmitResult,
  type Verdict,
  type VerdictRecord,
} from "./types";

/**
 * Append-only, hash-chained nonce ledger.
 *
 * DELIBERATELY A FILE, NOT A DATABASE TABLE.
 * A table is mutable by anyone holding the connection, and "we only ever INSERT"
 * is a promise about our code. An append-only file that carries a hash chain is
 * a property of the artefact itself: edit any line and every subsequent entryHash
 * stops matching, which verifyChain() will point at by index.
 *
 * Three paths, and only three:
 *   eventID unseen                      -> record, return the new verdict
 *   eventID seen, payload identical     -> NO-OP, return the ORIGINAL verdict
 *   eventID seen, payload different     -> ABORT with EVENT_ID_REUSE
 *
 * The middle path is not a nicety. Couriers double-tap in dead spots, and
 * treating that as forgery would be a false positive aimed at a person.
 */
export class NonceLedger {
  readonly path: string;

  /** eventID -> first-sighting binding. Rebuilt from the file, never authoritative in itself. */
  private registry = new Map<string, { payloadHash: string; verdict: Verdict; seq: number }>();
  private nextSeq = 0;
  private lastEntryHash = GENESIS_PREV_HASH;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.rebuild();
  }

  /**
   * Rebuild the in-memory registry from the file.
   *
   * Called on construction, which is what makes restart recovery real rather
   * than claimed: kill the process mid-demo and the replay is still caught.
   */
  rebuild(): void {
    this.registry.clear();
    this.nextSeq = 0;
    this.lastEntryHash = GENESIS_PREV_HASH;

    for (const record of this.readRecords()) {
      this.nextSeq = record.seq + 1;
      this.lastEntryHash = record.entryHash;
      // Abort records are audit trail only. An attacker must not be able to
      // rebind an eventID by submitting a forgery after the fact.
      if (record.kind === "verdict" && !this.registry.has(record.eventID)) {
        this.registry.set(record.eventID, {
          payloadHash: record.payloadHash,
          verdict: record.verdict,
          seq: record.seq,
        });
      }
    }
  }

  /** Every parsed record, in file order. Throws on a malformed line. */
  readRecords(): LedgerRecord[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
    const records: LedgerRecord[] = [];

    for (const [i, line] of text.split("\n").entries()) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`ledger line ${i + 1} is not valid JSON`);
      }
      const result = LedgerRecord.safeParse(parsed);
      if (!result.success) {
        throw new Error(`ledger line ${i + 1} does not match the record schema`);
      }
      records.push(result.data);
    }
    return records;
  }

  /** Existing verdict for an eventID, if it has been seen. */
  lookup(eventID: string): Verdict | undefined {
    return this.registry.get(eventID)?.verdict;
  }

  get size(): number {
    return this.registry.size;
  }

  /**
   * The replay check (H4), without recording anything.
   *
   * Split out from `submit` because the agent must run this at node 4 `verify`
   * — before spending any work on an event that is a replay — while the verdict
   * it would record is not produced until node 7 `gate`.
   *
   * A `reuse` outcome DOES append an abort record: the attempt is terminal and
   * the attempt itself is evidence.
   */
  check(eventID: string, payload: unknown): CheckResult {
    const payloadHash = canonicalHash(payload);
    const bound = this.registry.get(eventID);

    if (!bound) return { status: "unseen", payloadHash };

    if (bound.payloadHash === payloadHash) {
      return { status: "duplicate", seq: bound.seq, verdict: bound.verdict, payloadHash };
    }

    this.appendAbort(eventID, payloadHash, bound.payloadHash);
    return {
      status: "reuse",
      code: "EVENT_ID_REUSE",
      boundPayloadHash: bound.payloadHash,
      submittedPayloadHash: payloadHash,
    };
  }

  /**
   * Seal a verdict for an eventID that `check` reported as unseen.
   * Throws if the eventID is already bound — the ledger has no update path,
   * which is the point of it.
   */
  commit(eventID: string, payload: unknown, verdict: Verdict): { seq: number } {
    if (this.registry.has(eventID)) {
      throw new Error(`eventID ${eventID} is already bound; the ledger has no update path`);
    }
    const payloadHash = canonicalHash(payload);
    const seq = this.appendVerdict(eventID, payloadHash, verdict);
    this.registry.set(eventID, { payloadHash, verdict, seq });
    return { seq };
  }

  /**
   * Check and record in one step.
   *
   * `computeVerdict` is only invoked on the first-sighting path, so a retry can
   * never produce a *different* verdict from the same payload — the original is
   * replayed verbatim. That is what makes idempotency observable rather than
   * merely intended.
   */
  submit(eventID: string, payload: unknown, computeVerdict: () => Verdict): SubmitResult {
    const checked = this.check(eventID, payload);

    if (checked.status === "duplicate") {
      return { status: "noop", seq: checked.seq, verdict: checked.verdict };
    }
    if (checked.status === "reuse") {
      return {
        status: "aborted",
        code: checked.code,
        boundPayloadHash: checked.boundPayloadHash,
        submittedPayloadHash: checked.submittedPayloadHash,
      };
    }

    const verdict = computeVerdict();
    const { seq } = this.commit(eventID, payload, verdict);
    return { status: "recorded", seq, verdict };
  }

  /**
   * Walk the chain from genesis and confirm nothing has been edited, removed
   * or reordered. Returns the index of the first break, not just a boolean,
   * so an operator is told WHERE the tampering is.
   */
  verifyChain(): ChainVerification {
    let expectedPrev = GENESIS_PREV_HASH;
    let records: LedgerRecord[];

    try {
      records = this.readRecords();
    } catch (err) {
      return { valid: false, brokenAt: -1, reason: (err as Error).message };
    }

    for (const [i, record] of records.entries()) {
      if (record.seq !== i) {
        return { valid: false, brokenAt: i, reason: `expected seq ${i}, found ${record.seq}` };
      }
      if (record.prevHash !== expectedPrev) {
        return { valid: false, brokenAt: i, reason: "prevHash does not match the preceding entry" };
      }
      if (entryHashOf(record) !== record.entryHash) {
        return { valid: false, brokenAt: i, reason: "entryHash does not match this entry's content" };
      }
      expectedPrev = record.entryHash;
    }

    return { valid: true, entries: records.length };
  }

  private appendVerdict(eventID: string, payloadHash: string, verdict: Verdict): number {
    const seq = this.nextSeq;
    const draft = {
      kind: "verdict" as const,
      seq,
      eventID,
      payloadHash,
      recordedAt: new Date().toISOString(),
      prevHash: this.lastEntryHash,
    };
    this.writeLine({ ...draft, verdict, entryHash: "" });
    return seq;
  }

  private appendAbort(eventID: string, payloadHash: string, boundPayloadHash: string): number {
    const seq = this.nextSeq;
    this.writeLine({
      kind: "abort" as const,
      seq,
      eventID,
      payloadHash,
      recordedAt: new Date().toISOString(),
      prevHash: this.lastEntryHash,
      code: "EVENT_ID_REUSE" as const,
      boundPayloadHash,
      entryHash: "",
    });
    return seq;
  }

  /** Seal a record with its entryHash and append it. The only writer in this class. */
  private writeLine(record: LedgerRecord): void {
    const sealed = { ...record, entryHash: entryHashOf(record) } as LedgerRecord;
    appendFileSync(this.path, `${JSON.stringify(sealed)}\n`, "utf8");
    this.nextSeq = sealed.seq + 1;
    this.lastEntryHash = sealed.entryHash;
  }
}

/**
 * The link in the chain: sha256 over the canonical form of the record with
 * entryHash excluded, since a value cannot commit to itself.
 */
export function entryHashOf(record: LedgerRecord | (Omit<VerdictRecord, "entryHash"> | Omit<AbortRecord, "entryHash">)): string {
  const { entryHash: _omit, ...rest } = record as LedgerRecord;
  void _omit;
  return sha256Hex(canonicalHash(rest));
}

import { canonicalize } from "./canonical-form";
import { GENESIS_PREV_HASH, type ChainVerification, type LedgerRecord } from "./types";

/**
 * The chain walk. ONE implementation, shared by the server and the browser.
 *
 * NO CRYPTO HERE ON PURPOSE. Node hashes synchronously with `node:crypto`; a
 * browser can only hash asynchronously through `crypto.subtle`. If the walk
 * itself owned the digest, one of those two would need its own copy of the
 * linkage logic — and the copy that drifts is always the one without the
 * tests. So the caller computes the entry hashes with whatever primitive it
 * has, and hands them in alongside the records.
 *
 * What stays shared is everything that decides whether the chain is intact:
 * the sequence ordering, the `prevHash` linkage, the entry-hash comparison,
 * and WHICH INDEX breaks first. That last one is the point of the whole
 * design — tampering is located, not merely detected (CLAUDE.md rule 6).
 */

/** The record without its own entryHash: a value cannot commit to itself. */
export function withoutEntryHash(record: LedgerRecord): Record<string, unknown> {
  const { entryHash: _omit, ...rest } = record as LedgerRecord & { entryHash?: string };
  void _omit;
  return rest;
}

/**
 * The exact string an entry hash is taken over.
 *
 * Shared so the browser and the server cannot disagree about WHAT is hashed.
 * They still each apply the digest, and `chain.test.ts` pins that the two
 * recipes agree on real records.
 */
export function entryHashInput(record: LedgerRecord): string {
  return canonicalize(withoutEntryHash(record));
}

/**
 * Walk a chain whose entry hashes have already been computed.
 *
 * `entryHashes[i]` must be the hash RECOMPUTED from `records[i]`, not the value
 * the record carries. Comparing a record's stored hash against itself would
 * verify nothing, which is the one way to make this function vacuous.
 */
export function walkChain(
  records: LedgerRecord[],
  entryHashes: string[],
): ChainVerification {
  if (entryHashes.length !== records.length) {
    throw new Error("walkChain needs one recomputed hash per record");
  }

  let expectedPrev = GENESIS_PREV_HASH;

  for (const [i, record] of records.entries()) {
    if (record.seq !== i) {
      return { valid: false, brokenAt: i, reason: `expected seq ${i}, found ${record.seq}` };
    }
    if (record.prevHash !== expectedPrev) {
      return { valid: false, brokenAt: i, reason: "prevHash does not match the preceding entry" };
    }
    if (entryHashes[i] !== record.entryHash) {
      return { valid: false, brokenAt: i, reason: "entryHash does not match this entry's content" };
    }
    expectedPrev = record.entryHash;
  }

  return { valid: true, entries: records.length };
}

/**
 * Parse a `.jsonl` ledger.
 *
 * A malformed line is reported at its index rather than thrown away: a file
 * that will not parse is itself evidence about the artefact, and silently
 * skipping the line would let an attacker corrupt one entry to hide it.
 */
export function parseLedgerJsonl(
  text: string,
): { ok: true; records: LedgerRecord[] } | { ok: false; brokenAt: number; reason: string } {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const records: LedgerRecord[] = [];

  for (const [i, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line) as LedgerRecord);
    } catch {
      return { ok: false, brokenAt: i, reason: "line is not valid JSON" };
    }
  }

  return { ok: true, records };
}

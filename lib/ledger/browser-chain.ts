import { entryHashInput, parseLedgerJsonl, walkChain } from "./chain";
import type { ChainVerification, LedgerRecord } from "./types";

/**
 * Chain verification using only Web Crypto. Runs in the browser.
 *
 * WHY THIS EXISTS. "How do I know the audit trail was not edited?" is a
 * question the honest answer to is *check it yourself*, not *trust our server*.
 * A server endpoint that returns `{ valid: true }` proves nothing to a sceptic:
 * it is the same party that wrote the file telling you the file is fine. This
 * module recomputes the whole chain from the raw `.jsonl` in the visitor's own
 * browser, so the only thing they have to accept from us is the bytes.
 *
 * It shares `walkChain` with the server, so the page and `NonceLedger` cannot
 * reach different conclusions about the same file. The ONLY thing that differs
 * is the digest primitive — `crypto.subtle` here, `node:crypto` there.
 */

/** sha256 → lowercase hex, via Web Crypto. */
export async function sha256HexWeb(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The entry-hash recipe: two rounds of sha256 over the shared canonical form.
 *
 * Mirrors `entryHashOf` in ledger.ts. The canonical form itself is NOT
 * reimplemented — both sides call the one `canonicalize` — and
 * `chain.test.ts` asserts the two recipes agree on real records rather than
 * assuming they do.
 */
export async function entryHashWeb(record: LedgerRecord): Promise<string> {
  return sha256HexWeb(await sha256HexWeb(entryHashInput(record)));
}

export type BrowserVerification = ChainVerification & { records: number };

/**
 * Verify a ledger from its raw text, entirely client-side.
 *
 * Takes TEXT rather than parsed records so the caller cannot accidentally hand
 * this a structure the server already massaged. The visitor verifies the bytes
 * that were served.
 */
export async function verifyLedgerText(text: string): Promise<BrowserVerification> {
  const parsed = parseLedgerJsonl(text);
  if (!parsed.ok) {
    return { valid: false, brokenAt: parsed.brokenAt, reason: parsed.reason, records: 0 };
  }

  const entryHashes = await Promise.all(parsed.records.map(entryHashWeb));
  return { ...walkChain(parsed.records, entryHashes), records: parsed.records.length };
}

/**
 * Alter one line of a COPY and return the altered text.
 *
 * THE REAL LEDGER IS NEVER TOUCHED. This operates on a string the browser
 * already holds; there is no write path back to the file, and there must never
 * be one — a demo that could corrupt the artefact it is demonstrating would be
 * a worse bug than the one it illustrates.
 *
 * The edit changes a record's own content WITHOUT restating its `entryHash`,
 * which is precisely the tampering the chain exists to catch: the stored hash
 * no longer matches what the record now says, and every link after it is
 * orphaned. `walkChain` reports the first index that fails.
 */
export function tamperWithCopy(text: string, lineIndex: number): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lineIndex < 0 || lineIndex >= lines.length) return text;

  const record = JSON.parse(lines[lineIndex]) as LedgerRecord & { verdict?: { decision?: string } };
  // Flip the decision if there is one; otherwise mark the payload. Either way
  // the record's content changes and its recorded entryHash does not.
  if (record.verdict?.decision) {
    record.verdict.decision = record.verdict.decision === "accept" ? "freeze" : "accept";
  } else {
    (record as unknown as { payloadHash: string }).payloadHash = "0".repeat(64);
  }

  lines[lineIndex] = JSON.stringify(record);
  return `${lines.join("\n")}\n`;
}

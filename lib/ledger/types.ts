import { z } from "zod";

/** The four outputs of the orthogonal gate. See CLAUDE.md. */
export const Decision = z.enum(["accept", "flag", "escalate", "freeze"]);
export type Decision = z.infer<typeof Decision>;

/**
 * How much of the evidence picture the decision actually rests on.
 *
 * Without this, an accept made on a complete picture and an accept made because
 * the courier is too new to have a pattern look identical in the record.
 */
export const VerdictBasis = z.enum([
  /** Both axes were evaluable. */
  "both_axes",
  /** Only the single-event axis; the courier has no usable pattern history. */
  "single_event_only",
  /** The single-event axis could not be evaluated. */
  "insufficient_evidence",
]);
export type VerdictBasis = z.infer<typeof VerdictBasis>;

/**
 * A verdict as stored in the ledger.
 *
 * The on-disk format must not change once real entries exist, because changing
 * it would invalidate every hash in the chain. `basis` and `requiresCosign`
 * were added in session 3, while no committed ledger data existed — the local
 * .jsonl files are gitignored dev state, so the change cost nothing. Any
 * further change to this shape is no longer free.
 *
 * The two scores are deliberately separate fields, never summed. See CLAUDE.md.
 */
export const Verdict = z.strictObject({
  decision: Decision,
  /** Axis 1 — single-event contradiction (H1–H4, I1–I16). 0..100. */
  inconsistencyScore: z.number().min(0).max(100),
  /** Axis 2 — per-courier rolling pattern (P1–P5). 0..100. */
  patternScore: z.number().min(0).max(100),
  /** What the decision rests on. */
  basis: VerdictBasis,
  /**
   * True when a courier-signed token alone must not verify for this handoff.
   * Sealed into the ledger because it is part of what was decided, not a UI hint.
   */
  requiresCosign: z.boolean(),
  /** Machine-readable flag codes, e.g. "I4", "H2". Explanations are rendered from these. */
  flags: z.array(z.string()),
  /** Set when a hard check aborted the event outright. */
  abortCode: z.string().optional(),
});
export type Verdict = z.infer<typeof Verdict>;

const HEX64 = /^[0-9a-f]{64}$/;

/** Fields common to every ledger line. */
const LedgerBase = {
  /** Monotonic, gap-free from 0. A gap means a line was removed. */
  seq: z.number().int().nonnegative(),
  eventID: z.uuid(),
  /** canonicalHash() of the event payload. */
  payloadHash: z.string().regex(HEX64),
  /** Server clock at the moment of append. */
  recordedAt: z.iso.datetime({ offset: true }),
  /** entryHash of seq-1, or 64 zeros for the genesis entry. */
  prevHash: z.string().regex(HEX64),
  /** sha256 over the canonical form of this record with entryHash omitted. */
  entryHash: z.string().regex(HEX64),
};

/** A first-sighting of an eventID: the binding that later replays are checked against. */
export const VerdictRecord = z.strictObject({
  kind: z.literal("verdict"),
  ...LedgerBase,
  verdict: Verdict,
});
export type VerdictRecord = z.infer<typeof VerdictRecord>;

/**
 * A rejected replay. Written to the ledger rather than only logged, because an
 * attacker's failed attempts are evidence, and evidence belongs in the audit trail.
 * Abort records never create or overwrite an eventID binding.
 */
export const AbortRecord = z.strictObject({
  kind: z.literal("abort"),
  ...LedgerBase,
  code: z.literal("EVENT_ID_REUSE"),
  /** The payloadHash originally bound to this eventID. */
  boundPayloadHash: z.string().regex(HEX64),
});
export type AbortRecord = z.infer<typeof AbortRecord>;

export const LedgerRecord = z.discriminatedUnion("kind", [VerdictRecord, AbortRecord]);
export type LedgerRecord = z.infer<typeof LedgerRecord>;

export const GENESIS_PREV_HASH = "0".repeat(64);

/** Result of submitting an event to the ledger. */
export type SubmitResult =
  | { status: "recorded"; seq: number; verdict: Verdict }
  /** Same eventID, byte-equivalent payload: a retry, not an attack. */
  | { status: "noop"; seq: number; verdict: Verdict }
  /** Same eventID, different payload: forgery. */
  | {
      status: "aborted";
      code: "EVENT_ID_REUSE";
      boundPayloadHash: string;
      submittedPayloadHash: string;
    };

/** Result of the replay check, before any verdict is computed. */
export type CheckResult =
  /** First sighting. Proceed, then commit(). */
  | { status: "unseen"; payloadHash: string }
  /** Same eventID, byte-equivalent payload: a retry, not an attack. */
  | { status: "duplicate"; seq: number; verdict: Verdict; payloadHash: string }
  /** Same eventID, different payload: forgery. Already written to the audit trail. */
  | {
      status: "reuse";
      code: "EVENT_ID_REUSE";
      boundPayloadHash: string;
      submittedPayloadHash: string;
    };

/** Result of verifying the hash chain end to end. */
export type ChainVerification =
  | { valid: true; entries: number }
  | { valid: false; brokenAt: number; reason: string };

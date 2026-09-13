import type { AgentContext } from "@/lib/agent/context";

/**
 * What the inbox needs to decide which group a row belongs in and what to say
 * about it in a few words. Every input here is something a decider already
 * recorded — the gate's matrix cell, the engine's abort, the ledger's status —
 * so nothing below re-compares a score against a threshold (rule 3g).
 */

/**
 * The short name for every rule, keyed by the id the rule itself emits.
 *
 * A list scans; a detail page reads. The full sentence stays on the detail page
 * where a reviewer has already committed to reading. These are for picking which
 * row to open.
 *
 * NOT A HAND-MAINTAINED INCLUSION LIST IN DISGUISE. `inbox.test.ts` enumerates
 * the engine and pattern registries and the hard checks' own ids, and fails if
 * any id has no short label — so a seventeenth rule cannot arrive unlabelled.
 */
export const RULE_SHORT_LABELS: Readonly<Record<string, string>> = {
  H1: "Custody gap (H1)",
  H2: "Out of scope (H2)",
  H3: "Mandate not valid (H3)",
  I1: "GPS contradicts cell",
  I2: "Motion contradicts sensor",
  I3: "Impossible speed",
  I4: "Clock divergence",
  I5: "Upload held offline",
  I6: "Unissued handset",
  I7: "Mock location",
  I8: "Device integrity failed",
  I9: "Photo time mismatch",
  I10: "Far from recipient",
  I11: "Away from recipient",
  I12: "Proof of delivery missing",
  I13: "Outside working hours",
  I14: "Battery contradicts journey",
  I15: "OTP channel conflict",
  I16: "Attestation below enrollment",
  P1: "Burst scanning",
  P2: "Dispute rate",
  P3: "Scores hug a threshold",
  P4: "Clustered scans",
  P5: "Recurring contradiction",
};

/** Why a handoff was refused before any score could stand, if it was. */
export type AbortKind = "hard_check" | "event_id_reuse" | "credential_invalid" | null;

export function abortKindOf(ctx: AgentContext): AbortKind {
  if (ctx.ledger?.status === "aborted") return "event_id_reuse";
  if (ctx.engineResult?.aborted) return "hard_check";
  const code = ctx.verdict?.abortCode;
  if (code === "CREDENTIAL_INVALID") return "credential_invalid";
  if (code === "EVENT_ID_REUSE") return "event_id_reuse";
  if (code) return "hard_check";
  return null;
}

/** True when the gate itself put this handoff in a high-pattern cell. */
export function isPatternHigh(matrixCell: string | null): boolean {
  return matrixCell !== null && matrixCell.endsWith("/high-pattern");
}

/**
 * A few words for the reason column, derived from what decided.
 *
 * Order matters and mirrors severity: an abort explains itself before any score
 * does; a pattern cell names the pattern before the single-event flags, because
 * in that cell the single event is not what is wrong.
 */
export function shortReasonFor(ctx: AgentContext): string {
  const abort = abortKindOf(ctx);
  if (abort === "event_id_reuse") return "Event ID replayed";
  if (abort === "credential_invalid") return "Signature invalid (C1)";
  if (abort === "hard_check") {
    const id = ctx.engineResult?.hardFailures[0]?.id ?? ctx.verdict?.abortCode;
    return (id && RULE_SHORT_LABELS[id]) ?? "Refused by a hard check";
  }

  const cell = ctx.gateResult?.matrixCell ?? null;
  const flags = [...(ctx.engineResult?.flags ?? [])].sort((a, b) => b.points - a.points);
  const top = flags[0] ? (RULE_SHORT_LABELS[flags[0].id] ?? flags[0].id) : null;

  if (isPatternHigh(cell)) {
    return top ? `Pattern anomaly · ${top}` : "Pattern anomaly · singles clean";
  }
  if (top) return top;
  if (cell?.endsWith("/cold-start")) return "No pattern history yet";
  return "No findings";
}

export type InboxGroupId = "refused" | "waiting" | "pattern" | "other";

/**
 * The four groups, most severe first. Each row lands in exactly one: the first
 * it qualifies for.
 *
 * WHY REFUSED COMES BEFORE WAITING. "Someone is waiting" means a person is at the
 * door. A refusal means an attack or an impossible state has already happened —
 * and nobody is blocked by it, which is exactly why a priority built on "who is
 * blocked" would put it last. See CLAUDE.md, session 23.
 */
export const INBOX_GROUPS: ReadonlyArray<{ id: InboxGroupId; title: string; detail: string }> = [
  { id: "refused", title: "Refused by a hard check", detail: "An attack or an impossible state was stopped before any score could stand." },
  { id: "waiting", title: "Someone is waiting for you", detail: "Nothing can seal until an operator signs." },
  { id: "pattern", title: "Pattern anomaly", detail: "Each handoff passes on its own; the courier's distribution does not. Grouped by courier." },
  { id: "other", title: "Everything else", detail: "Flagged, and nobody is blocked." },
];

export function inboxGroupOf(row: {
  abort: AbortKind;
  state: string;
  matrixCell: string | null;
}): InboxGroupId {
  if (row.abort !== null) return "refused";
  if (row.state === "awaiting_cosignature" || row.state === "timed_out") return "waiting";
  if (isPatternHigh(row.matrixCell)) return "pattern";
  return "other";
}

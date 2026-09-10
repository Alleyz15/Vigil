import type { RunView } from "./read-model";

/**
 * What the courier is told about a submission, derived from what actually
 * happened rather than from a string chosen at the call site.
 *
 * WHY THIS IS DERIVED. The same reasoning as the reroute rejection reasons and
 * the map overlays: text that restates a decision must be computed FROM that
 * decision, or the two drift the first time the underlying rule moves. A
 * hardcoded "your submission needs approval" would keep saying that after the
 * credential check changed its mind.
 *
 * TWO DISTINCTIONS THIS SCREEN EXISTS TO MAKE VISIBLE:
 *
 * 1. `signature_insufficient` is NOT a policy refusal. The courier's signature
 *    is cryptographically valid; it is simply not a complete credential for a
 *    handoff at this risk level. Saying "rejected" would describe a different
 *    system — one where approval is a flag someone did not tick. See rule 3.
 *
 * 2. `replay_noop` versus `replay_reused_id`. Both are "you submitted the same
 *    event id twice". One is an honest courier tapping again on a bad
 *    connection and is a NO-OP that returns the original verdict; the other is
 *    the same id carrying DIFFERENT content, which is the most incriminating
 *    thing the ledger ever sees. The whole point of hashing the canonicalised
 *    payload is that the system tells them apart, so the UI must too — showing
 *    one label for both would throw away the distinction rule 5 exists to make.
 */
export type CourierOutcomeKind =
  | "sealed"
  | "signature_insufficient"
  | "signature_missing"
  | "signature_invalid"
  | "replay_noop"
  | "replay_reused_id"
  | "undecided";

export type CourierOutcome = {
  kind: CourierOutcomeKind;
  /** Short line, safe to render large. */
  headline: string;
  /** One sentence of plain explanation. */
  detail: string;
  /** True when a ledger entry exists for this submission. */
  sealed: boolean;
  /**
   * Verbatim verifier problems, so the screen can show what the credential
   * check actually said rather than only our summary of it.
   */
  problems: string[];
};

/**
 * Read a completed submission.
 *
 * Order matters: a reused event id is decided by the ledger before the
 * credential is relevant, and a missing courier signature is checked before an
 * incomplete one, because "you did not sign" and "you signed but that is not
 * enough" are different sentences to say to a person.
 */
export function courierOutcome(run: RunView): CourierOutcome {
  const credential = run.credential;
  const problems = credential?.problems ?? [];

  if (run.ledgerStatus === "aborted") {
    return {
      kind: "replay_reused_id",
      headline: "Rejected — this event ID was already used for different content",
      detail:
        "The ID has been seen before carrying a different payload. The attempt is recorded in the ledger as evidence; it did not overwrite the original.",
      sealed: false,
      problems,
    };
  }

  if (run.ledgerStatus === "noop") {
    return {
      kind: "replay_noop",
      headline: "Already recorded — no change",
      detail:
        "This is the same handoff, submitted again. It matches what was recorded byte for byte, so the original result stands. Tapping twice is not a problem.",
      sealed: true,
      problems,
    };
  }

  if (run.halted?.reason === "PENDING_COURIER_SIGNATURE") {
    return {
      kind: "signature_missing",
      headline: "Not signed — nothing was recorded",
      detail:
        "Every handoff needs your signature. Nothing was written, so this is not a refusal: the handoff simply has not been submitted yet.",
      sealed: false,
      problems,
    };
  }

  if (run.halted?.reason === "PENDING_COSIGNATURE") {
    return {
      kind: "signature_insufficient",
      headline: "Signature valid, but insufficient",
      detail:
        "This credential cannot be verified without an operator signature. Your signature checked out; a handoff at this risk level needs both. Nothing was recorded either way.",
      sealed: false,
      problems,
    };
  }

  if (credential && !credential.valid && run.decision === "freeze") {
    return {
      kind: "signature_invalid",
      headline: "Signature did not verify",
      detail:
        "The credential presented does not verify against the keys on file. That is recorded as evidence rather than discarded.",
      sealed: run.sealed,
      problems,
    };
  }

  if (run.sealed) {
    return {
      kind: "sealed",
      headline: "Recorded",
      detail: `The handoff was verified and sealed${run.decision ? ` as "${run.decision}"` : ""}. The ledger entry cannot be edited afterwards.`,
      sealed: true,
      problems,
    };
  }

  return {
    kind: "undecided",
    headline: "Nothing was recorded",
    detail:
      run.halted?.reason
        ? `The run stopped at ${run.halted.at} (${run.halted.reason}) and wrote nothing.`
        : "The run did not reach a decision and wrote nothing.",
    sealed: false,
    problems,
  };
}

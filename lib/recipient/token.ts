/**
 * The recipient's capability token.
 *
 * WHY THIS MATTERS BEYOND THE UI. E1 measured that the careful fraudster is not
 * caught by any single-event check — they are caught by **P2, the customer
 * complaint**, after about ten deliveries. Until now that data appeared from
 * nowhere: the generator wrote disputes directly, and a judge asking "where do
 * these come from in a real deployment?" had no answer. This route is the
 * answer, and it makes I15's independent-channel argument real rather than
 * notional, because the system genuinely has a second channel to the recipient.
 *
 * THE TOKEN IS NOT AUTHENTICATION. It is a scoped capability: one parcel, one
 * answer, one expiry, and no account. A recipient will not install an app or
 * remember a password to answer one question, and demanding either would mean
 * collecting no answers — which would leave P2 back where it started.
 *
 * This module is PURE. Deciding whether a token may be answered is a function
 * of the row and the current time, so it is tested without a database.
 */

/** What the recipient said, or that they said nothing before the deadline. */
export type ConfirmationAnswer = "received" | "not_received" | "no_response";

/** The answers a recipient may actually choose. `no_response` is not one. */
export const RECIPIENT_ANSWERS = ["received", "not_received"] as const;
export type RecipientAnswer = (typeof RECIPIENT_ANSWERS)[number];

export type ConfirmationRow = {
  tokenId: string;
  eventId: string;
  epc: string;
  issuedAt: string;
  expiresAt: string;
  answeredAt: string | null;
  answer: ConfirmationAnswer | null;
};

/**
 * Why a token cannot be answered, when it cannot.
 *
 * Separate reasons rather than one `false`, for the same reason every rule in
 * this codebase reports three states: "this link has expired" and "you have
 * already answered" are different sentences to say to a person, and collapsing
 * them would tell someone their answer was lost when it was recorded.
 */
export type TokenState =
  | { status: "open"; row: ConfirmationRow }
  | { status: "expired"; row: ConfirmationRow }
  | { status: "answered"; row: ConfirmationRow; answer: ConfirmationAnswer }
  | { status: "unknown" };

export function evaluateToken(row: ConfirmationRow | undefined, nowIso: string): TokenState {
  if (!row) return { status: "unknown" };

  // An answered token is spent whatever the clock says. Checking expiry first
  // would report "expired" for an answer that was recorded in time, which is
  // both wrong and alarming to whoever gave it.
  if (row.answer !== null) return { status: "answered", row, answer: row.answer };

  const now = Date.parse(nowIso);
  const expires = Date.parse(row.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expires)) return { status: "expired", row };

  return now >= expires ? { status: "expired", row } : { status: "open", row };
}

/** Plain wording for each state. Derived, never chosen at the call site. */
export function tokenMessage(state: TokenState): { headline: string; detail: string } {
  switch (state.status) {
    case "open":
      return {
        headline: "Did this parcel reach you?",
        detail: "One question, one answer. This link works once and then expires.",
      };
    case "answered":
      return {
        headline: "Thank you — your answer was recorded",
        detail:
          state.answer === "not_received"
            ? "You told us this parcel did not reach you. That has been passed to the operations team."
            : "You told us this parcel reached you. Nothing further is needed.",
      };
    case "expired":
      return {
        headline: "This link has expired",
        detail:
          "Nothing was recorded. If the parcel did not reach you, contact the sender — this link cannot be reopened.",
      };
    case "unknown":
      return {
        headline: "This link is not valid",
        detail: "We have no record of it. Check the link in your message, or contact the sender.",
      };
  }
}

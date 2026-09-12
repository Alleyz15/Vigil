/**
 * Canonical JSON serialisation. NO CRYPTO, NO NODE BUILTINS.
 *
 * SPLIT OUT SO A BROWSER CAN IMPORT IT. `canonical.ts` still owns the hashing,
 * which needs `node:crypto`; importing that module from a client component
 * would drag a Node builtin into the bundle. The browser-side ledger verifier
 * needs the canonical FORM and supplies its own digest via `crypto.subtle`.
 *
 * THIS IS A MOVE, NOT A COPY, AND THAT MATTERS. There is exactly one
 * canonicalisation in this codebase and there must remain exactly one: the
 * ledger's central rule is that the same eventID with the same payload is a
 * NO-OP returning the original verdict, and a second implementation that
 * disagreed about key ordering by one character would turn a courier tapping
 * twice in a dead spot into an EVENT_ID_REUSE forgery alert against a real
 * person. See CLAUDE.md rule 5.
 */

/** Deterministic serialisation. Object keys sorted by UTF-16 code unit. */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("cannot canonicalize a non-finite number");
      }
      // Normalise -0 to 0 so two equal payloads cannot hash differently.
      return JSON.stringify(value === 0 ? 0 : value);
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "undefined":
      throw new TypeError("cannot canonicalize undefined at a value position");
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError(`cannot canonicalize a ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // An absent key and a key set to undefined must hash the same, because
    // JSON.parse can never produce the latter. Dropping them keeps a
    // round-tripped payload identical to the one that was received.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}


import { createHash } from "node:crypto";
import { canonicalize } from "./canonical-form";

/**
 * Hashing over the canonical form.
 *
 * `canonicalize` itself lives in `./canonical-form`, which imports nothing from
 * Node, so the browser-side chain verifier can share the exact same
 * serialisation while supplying its own digest. One canonicalisation, two
 * digests. See that file for why a second copy would be a correctness bug
 * rather than a tidiness one.
 */

export { canonicalize } from "./canonical-form";

/** sha256 of the canonical form, lowercase hex. */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/** sha256 of an already-serialised string, lowercase hex. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

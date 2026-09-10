import { createHash } from "node:crypto";

/**
 * Normalise the registered delivery channel before comparing its fingerprint.
 * Generated Malaysian numbers are E.164 already; separators are tolerated so
 * storage formatting cannot create an identity contradiction by itself.
 */
export function normalizeRecipientChannel(channel: string): string {
  return channel.trim().replace(/[\s()-]/g, "");
}

/**
 * Stable comparison token, not a password hash or anonymisation guarantee.
 * Phone numbers have a small input space; callers must not expose this value as
 * though SHA-256 made the underlying channel secret.
 */
export function recipientChannelFingerprint(channel: string): string {
  return createHash("sha256").update(normalizeRecipientChannel(channel), "utf8").digest("hex");
}

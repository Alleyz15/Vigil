import { eq, and } from "drizzle-orm";
import type { VigilDb } from "@/lib/db/client";
import { mandates } from "@/lib/db/schema";
import { CourierMandate } from "@/lib/mandate/schema";
import { type Resolution, missing, resolved } from "./types";

/**
 * Rebuild a CourierMandate from its row.
 *
 * The row stores scope, limits, validity and the co-sign conditions as JSON
 * text; the domain type is nested and zod-validated. This is the one place the
 * two shapes are reconciled.
 *
 * FAILS CLOSED. If the JSON is malformed, or does not satisfy the schema, the
 * courier has NO usable mandate — not a permissive default, not a partially
 * populated object. Unparseable authorisation data must never be interpreted
 * generously; H2 then refuses the handoff for want of an authorisation, which
 * is the correct answer to "we cannot read what this courier is allowed to do".
 */
export function loadActiveMandate(
  db: VigilDb,
  courierId: string,
  resolution: Resolution,
): CourierMandate | undefined {
  const row = db
    .select()
    .from(mandates)
    .where(and(eq(mandates.courierId, courierId), eq(mandates.status, "active")))
    .get();

  if (!row) {
    missing(resolution, "mandate", `no active mandate on file for ${courierId}`);
    return undefined;
  }

  let candidate: unknown;
  try {
    candidate = {
      mandateId: row.mandateId,
      courierId: row.courierId,
      preset: row.preset,
      scope: JSON.parse(row.scopeJson),
      limits: JSON.parse(row.limitsJson),
      validity: JSON.parse(row.validityJson),
      requiresCosignIf: JSON.parse(row.requiresCosignIfJson),
      cooldownSeconds: row.cooldownSeconds,
      status: row.status,
      nonceCounter: row.nonceCounter,
    };
  } catch {
    missing(
      resolution,
      "mandate",
      `mandate ${row.mandateId} holds malformed JSON and cannot be read`,
    );
    return undefined;
  }

  const parsed = CourierMandate.safeParse(candidate);
  if (!parsed.success) {
    missing(
      resolution,
      "mandate",
      `mandate ${row.mandateId} does not satisfy the schema: ${parsed.error.issues
        .map((i) => i.path.join("."))
        .join(", ")}`,
    );
    return undefined;
  }

  resolved(resolution, `mandate ${row.mandateId}`);
  return parsed.data;
}

/** Serialise a CourierMandate into its row shape. Used by seeds and tests. */
export function mandateToRow(mandate: CourierMandate) {
  return {
    mandateId: mandate.mandateId,
    courierId: mandate.courierId,
    preset: mandate.preset,
    scopeJson: JSON.stringify(mandate.scope),
    limitsJson: JSON.stringify(mandate.limits),
    validityJson: JSON.stringify(mandate.validity),
    requiresCosignIfJson: JSON.stringify(mandate.requiresCosignIf),
    cooldownSeconds: mandate.cooldownSeconds,
    status: mandate.status,
    nonceCounter: mandate.nonceCounter,
  };
}

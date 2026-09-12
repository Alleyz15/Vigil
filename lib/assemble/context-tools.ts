import { and, eq, ne, sql } from "drizzle-orm";
import type { VigilDb } from "@/lib/db/client";
import { disputes, events, parcels, verdicts } from "@/lib/db/schema";
import type { ToolResult } from "@/lib/agent/context";

/**
 * The context tools, reading real rows.
 *
 * WHY THIS FILE EXISTS AT ALL. Until session 18, `fetch_route_history` and
 * `lookup_recipient_history` were names in a closed enum, branches in the
 * deterministic heuristic, and lines in the prompt the model reads — with NO
 * implementation anywhere. `externalContext` returned early unless the selected
 * tool was `check_traffic_weather`. Selecting either did nothing, every test
 * passed, and the model's one real decision mostly chose inert options. See
 * CLAUDE.md rule 1g, defect 6.
 *
 * THE RULE FOR ANYTHING ADDED HERE: a tool reads rows and counts them. It never
 * scores, never compares against a threshold, and never produces something the
 * gate could read. These results are context for the operator and citable
 * evidence for `explain`; they are not a third axis.
 *
 * This lives in `lib/assemble` with the rest of the I/O, deliberately outside
 * the purity guard.
 */

/** How far back a history lookup reaches. Context only — no rule reads this. */
const HISTORY_WINDOW_HOURS = 24 * 14;

/**
 * Time filtering happens in JS, on PARSED instants, never in SQL on strings.
 *
 * `events.eventTime` is stored verbatim, so it carries the offset it was
 * written with — `2026-09-08T10:15:00+08:00`. SQLite compares TEXT
 * lexicographically, so range-filtering that column against a `Z`-normalised
 * bound silently matches nothing: `"...T10:15:00+08:00"` sorts after
 * `"...T03:15:30.000Z"` even though it is the earlier instant.
 *
 * That is exactly how the first version of this file returned "no history" for
 * a courier who had just sealed a handoff. The row count is small — one
 * courier, one window — so parsing in JS is both correct and cheap, and it
 * cannot be defeated by a fleet that spans two offsets.
 */
function withinWindow(value: string | null, fromMs: number, toMs: number): boolean {
  if (!value) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && at >= fromMs && at < toMs;
}

/**
 * What this courier has been doing recently.
 *
 * Counts sealed handoffs and how they were decided. It reports the SHAPE of
 * recent work — how much, how it landed, over how many distinct parcels — and
 * deliberately computes no rate and no comparison. P1 and P3 already own the
 * per-courier statistics; a second one presented as "context" would invite
 * exactly the confusion rule 2 exists to prevent.
 */
export function fetchRouteHistory(db: VigilDb, courierId: string, nowIso: string): ToolResult {
  const toMs = Date.parse(nowIso);
  const fromMs = toMs - HISTORY_WINDOW_HOURS * 3_600_000;

  const rows = db
    .select({
      eventId: events.eventId,
      epc: events.primaryEpc,
      eventTime: events.eventTime,
      decision: verdicts.decision,
    })
    .from(events)
    .leftJoin(verdicts, eq(verdicts.eventId, events.eventId))
    // SQL narrows by courier, which the (courier_id, event_time) index covers.
    // The time window is applied below on parsed instants; see `withinWindow`.
    .where(eq(events.courierId, courierId))
    .all()
    .filter((row) => withinWindow(row.eventTime, fromMs, toMs));

  if (rows.length === 0) {
    return {
      tool: "fetch_route_history",
      found: false,
      summary: "No earlier handoffs are on file for this courier in the last 14 days.",
      detail: { handoffs: 0, windowHours: HISTORY_WINDOW_HOURS },
    };
  }

  const sealed = rows.filter((row) => row.decision !== null);
  const accepted = sealed.filter((row) => row.decision === "accept").length;
  const parcelsSeen = new Set(rows.map((row) => row.epc).filter(Boolean)).size;

  return {
    tool: "fetch_route_history",
    found: true,
    summary:
      `${rows.length} earlier handoffs across ${parcelsSeen} parcels in the last 14 days; ` +
      `${accepted} of ${sealed.length} sealed ones were accepted.`,
    detail: {
      handoffs: rows.length,
      parcels: parcelsSeen,
      sealed: sealed.length,
      accepted,
      windowHours: HISTORY_WINDOW_HOURS,
    },
  };
}

/**
 * Whether this recipient has disputed a delivery before.
 *
 * Keyed on the recipient's recorded phone, which is the same channel record
 * I15 checks a delivery against — not on the free-form name, which a courier
 * can read off the parcel and which varies honestly between households.
 *
 * "No prior disputes" is a REAL ANSWER and is returned as one, with
 * `found: false` so it cannot be cited. An empty panel would be
 * indistinguishable from a tool that was never asked.
 */
export function lookupRecipientHistory(db: VigilDb, epc: string, nowIso: string): ToolResult {
  const parcel = db.select().from(parcels).where(eq(parcels.epc, epc)).get();

  if (!parcel?.recipientPhone) {
    return {
      tool: "lookup_recipient_history",
      found: false,
      summary: "No recipient contact is on file for this parcel, so no history could be looked up.",
      detail: { priorDisputes: 0 },
    };
  }

  // Every parcel addressed to the same recipient channel, this one excluded.
  const siblings = db
    .select({ epc: parcels.epc })
    .from(parcels)
    .where(and(eq(parcels.recipientPhone, parcel.recipientPhone), ne(parcels.epc, epc)))
    .all();

  const priorDisputes = siblings.length
    ? db
        .select({ raisedAt: disputes.raisedAt })
        .from(disputes)
        .where(sql`${disputes.epc} in ${siblings.map((s) => s.epc)}`)
        .all()
        .filter((row) => Date.parse(row.raisedAt) < Date.parse(nowIso)).length
    : 0;

  if (priorDisputes === 0) {
    return {
      tool: "lookup_recipient_history",
      found: false,
      summary: `No prior disputes from this recipient across ${siblings.length} earlier parcels.`,
      detail: { priorParcels: siblings.length, priorDisputes: 0 },
    };
  }

  return {
    tool: "lookup_recipient_history",
    found: true,
    summary: `This recipient has disputed ${priorDisputes} of ${siblings.length} earlier parcels.`,
    detail: { priorParcels: siblings.length, priorDisputes },
  };
}

/**
 * What has happened at this address before.
 *
 * The question the other two cannot answer: a courier may be ordinary and a
 * recipient may be new, while the ADDRESS has a history — a tower with a
 * reception desk, a gated compound, a building where deliveries routinely fail.
 * Counts parcels addressed there and how their deliveries landed.
 */
export function checkAddressHistory(db: VigilDb, epc: string, nowIso: string): ToolResult {
  const parcel = db.select().from(parcels).where(eq(parcels.epc, epc)).get();

  if (!parcel?.recipientAddress) {
    return {
      tool: "check_address_history",
      found: false,
      summary: "No address is on file for this parcel, so no history could be looked up.",
      detail: { priorParcels: 0 },
    };
  }

  const siblings = db
    .select({ epc: parcels.epc })
    .from(parcels)
    .where(and(eq(parcels.recipientAddress, parcel.recipientAddress), ne(parcels.epc, epc)))
    .all();

  if (siblings.length === 0) {
    return {
      tool: "check_address_history",
      found: false,
      summary: "This is the first parcel on file for this address.",
      detail: { priorParcels: 0 },
    };
  }

  const epcs = siblings.map((s) => s.epc);
  const toMs = Date.parse(nowIso);
  const delivered = db
    .select({ eventId: events.eventId, eventTime: events.eventTime })
    .from(events)
    .where(
      and(
        sql`${events.primaryEpc} in ${epcs}`,
        eq(events.bizStep, "urn:epcglobal:cbv:bizstep:delivering"),
      ),
    )
    .all()
    .filter((row) => withinWindow(row.eventTime, Number.NEGATIVE_INFINITY, toMs));

  const disputed = db
    .select({ n: sql<number>`count(*)` })
    .from(disputes)
    .where(sql`${disputes.epc} in ${epcs}`)
    .get()?.n ?? 0;

  return {
    tool: "check_address_history",
    found: true,
    summary:
      `${siblings.length} other parcels on file for this address, ` +
      `${delivered.length} with a delivery scan and ${disputed} disputed.`,
    detail: { priorParcels: siblings.length, deliveries: delivered.length, disputed },
  };
}

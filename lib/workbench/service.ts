import { eq } from "drizzle-orm";
import { runAgent } from "@/lib/agent/machine";
import type { AgentContext } from "@/lib/agent/context";
import { closeDb, type VigilDb } from "@/lib/db/client";
import {
  deviceEnrollments,
  handoffCases,
  operatorActions,
  otpChallenges,
  parcels,
} from "@/lib/db/schema";
import {
  SCENARIO_IDS,
  buildScenario,
  buildWorld,
  createHarness,
  ingestEvent,
  ingestWithApproval,
  makeRng,
  recordDispute,
  seedFleetBackground,
  type BuiltEvent,
  type GeneratedScenario,
  type IngestHarness,
  type ScenarioId,
} from "@/lib/generate";
import { createOpenMeteoProvider, OPEN_METEO_CACHE_DIR } from "@/lib/weather";
import { epcsOf } from "@/lib/epcis";
import { rmSync } from "node:fs";
import { OperatorActionRequest, type CaseState, type OperatorActionRequest as ActionRequest } from "./types";
import { isQueueState, transitionCase } from "./state";
import { buildShipmentMapModel } from "./map-model";
import { courierOutcome, type CourierOutcome } from "./courier";
import {
  flagsFrom,
  runView,
  summaryFrom,
  type ActionView,
  type HandoffDetail,
  type HandoffSummary,
  type RunView,
  type WorkbenchEntry,
} from "./read-model";

const SEED = "vigil-2026";

/**
 * The scenarios whose final leg is reserved for the courier to submit.
 *
 * S1 is a handoff the gate says needs a co-signature, so a courier-only
 * credential is valid and insufficient. S0 is ordinary work, so it seals on the
 * courier's signature alone — which is what makes the unsigned attempt against
 * it the honest demonstration that an absent signature halts rather than
 * refuses, with no risk-level confound.
 */
const DRAFT_TITLES: Partial<Record<ScenarioId, string>> = {
  S1: "Delivery scan — needs an operator co-signature",
  S0: "Delivery scan — ordinary work",
};
const START_MS = Date.parse("2026-09-07T14:30:00+08:00");
const OPERATOR_ID = "OP-01";

type StoredEntry = WorkbenchEntry & { harness: IngestHarness; actions: ActionView[] };

function priorityFor(state: CaseState | null, decision?: string): number {
  if (state === "timed_out") return 500;
  if (state === "awaiting_cosignature") return 400;
  if (decision === "freeze") return 320;
  if (decision === "escalate") return 260;
  if (state === "flagged") return 200;
  return 0;
}

function reasonFor(ctx: StoredEntry["current"]): string {
  if (ctx.halted?.reason === "PENDING_COSIGNATURE") {
    return ctx.gateResult?.cosignReasons[0] ?? "Operator co-signature is required before anything can seal.";
  }
  if (ctx.ledger?.status === "aborted") return "The event ID was reused with a different payload.";
  return (
    ctx.gateResult?.rationale ??
    ctx.engineResult?.hardFailures[0]?.label ??
    ctx.engineResult?.flags[0]?.label ??
    "Both axes are low and mandate limits are satisfied."
  );
}

function upsertScenarioParcels(harness: IngestHarness, scenario: GeneratedScenario): void {
  for (const parcel of scenario.parcels) {
    harness.deps.db
      .insert(parcels)
      .values({
        epc: parcel.epc,
        waybillNo: parcel.waybillNo,
        recipientName: parcel.recipientName,
        recipientPhone: parcel.recipientPhone,
        recipientAddress: parcel.recipientAddress,
        recipientLat: parcel.recipientPoint.latitude,
        recipientLng: parcel.recipientPoint.longitude,
        declaredValueSen: parcel.declaredValueSen,
        codAmountSen: parcel.codAmountSen,
      })
      .onConflictDoUpdate({
        target: parcels.epc,
        set: {
          waybillNo: parcel.waybillNo,
          recipientName: parcel.recipientName,
          recipientPhone: parcel.recipientPhone,
          recipientAddress: parcel.recipientAddress,
          recipientLat: parcel.recipientPoint.latitude,
          recipientLng: parcel.recipientPoint.longitude,
          declaredValueSen: parcel.declaredValueSen,
          codAmountSen: parcel.codAmountSen,
        },
      })
      .run();
  }
}

/**
 * Build one scenario, optionally reserving its final leg for the courier.
 *
 * RESERVED, NOT DUPLICATED — and the first attempt got this wrong in a way only
 * a browser walk-through exposed. Building the courier's shipment as a SEPARATE
 * seeded instance looked safer (it added rather than rearranged) but produced
 * two shipments sharing one event id: `uuidFrom` derives the id from the
 * scenario name and leg alone, so the world seed does not enter it. The
 * workbench keys entries by event id, so promoting the courier's submission
 * silently overwrote the operator's identically-identified case. Nothing threw.
 *
 * One shipment, one identity, one harness. It is the FINAL leg specifically:
 * holding back a middle scan would break H1 for every leg after it.
 */
async function buildScenarioEntries(
  id: ScenarioId,
  options: { holdBackFinalLeg?: boolean } = {},
): Promise<{ entries: StoredEntry[]; draft?: StoredDraft }> {
  const world = buildWorld(SEED);
  const scenario = buildScenario(id, { world, rng: makeRng(SEED), startMs: START_MS });
  const harness = createHarness(world);
  harness.deps.weather = createOpenMeteoProvider({
    cacheDir: OPEN_METEO_CACHE_DIR,
    network: "cache-only",
  });
  seedFleetBackground(harness, world, {
    excludeCourierId: scenario.courier.courierId,
    startMs: START_MS - 8 * 3_600_000,
  });
  upsertScenarioParcels(harness, scenario);

  const credentialArgs = {
    courierPrivateKey: scenario.courier.keys.privateKey,
    mandateId: scenario.courier.mandate.mandateId,
  };
  for (const built of scenario.warmup) await ingestWithApproval(harness, built, credentialArgs);

  const timeline = options.holdBackFinalLeg ? scenario.timeline.slice(0, -1) : scenario.timeline;
  const held = options.holdBackFinalLeg ? scenario.timeline[scenario.timeline.length - 1] : undefined;

  const entries: StoredEntry[] = [];
  for (const built of timeline) {
    const leavePending =
      (id === "S1" || id === "S5") && built.leg === scenario.expectation.exceptionAtLeg;
    const result = leavePending
      ? { ctx: await ingestEvent(harness, built, credentialArgs), neededCosign: false }
      : await ingestWithApproval(harness, built, credentialArgs);
    const ctx = result.ctx;
    const pending = ctx.halted?.reason === "PENDING_COSIGNATURE";
    const actionable = pending || (ctx.decision !== undefined && ctx.decision !== "accept");
    const state: CaseState | null = pending
      ? id === "S5"
        ? "timed_out"
        : "awaiting_cosignature"
      : actionable
        ? "flagged"
        : null;
    const caseId = state ? `CASE-${id}-${built.legIndex}` : null;
    const createdAt = built.event.recordTime ?? built.event.eventTime;
    const entry: StoredEntry = {
      scenario,
      world,
      built,
      current: ctx,
      runs: [ctx],
      state,
      caseId,
      priority: priorityFor(state, ctx.decision),
      reason: reasonFor(ctx),
      createdAt,
      harness,
      actions: [],
    };
    entries.push(entry);

    if (state && caseId) {
      harness.deps.db
        .insert(handoffCases)
        .values({
          caseId,
          eventId: built.event.eventID,
          scenarioId: id,
          legIndex: built.legIndex,
          state,
          priority: entry.priority,
          reason: entry.reason,
          payloadJson: JSON.stringify(built.event),
          contextJson: JSON.stringify(ctx),
          traceJson: JSON.stringify(ctx.trace),
          createdAt,
          dueAt: id === "S5" ? new Date(Date.parse(createdAt) + 5 * 60_000).toISOString() : null,
          updatedAt: createdAt,
        })
        .run();
    }

    if (scenario.disputedEventIds.includes(built.event.eventID)) {
      recordDispute(harness, built.event.eventID, epcsOf(built.event)[0] ?? "");
    }
  }

  if (scenario.replay) {
    const replay = await ingestEvent(harness, scenario.replay.event, { ...credentialArgs, withCosign: true });
    const original = entries.find((entry) => entry.built.event.eventID === scenario.replay!.event.event.eventID);
    if (original) {
      original.runs.push(replay);
      original.current = replay;
      original.state = "flagged";
      original.caseId = `CASE-${id}-replay`;
      original.priority = priorityFor("flagged", "freeze");
      original.reason = reasonFor(replay);
      original.harness.deps.db
        .insert(handoffCases)
        .values({
          caseId: original.caseId,
          eventId: original.built.event.eventID,
          scenarioId: id,
          legIndex: original.built.legIndex,
          state: "flagged",
          priority: original.priority,
          reason: original.reason,
          payloadJson: JSON.stringify(original.built.event),
          contextJson: JSON.stringify(replay),
          traceJson: JSON.stringify(replay.trace),
          runCount: 2,
          createdAt: original.createdAt,
          updatedAt: original.createdAt,
        })
        .run();
    }
  }

  const draft = held ? makeDraft(id, scenario, world, harness, held) : undefined;
  return { entries, draft };
}

/**
 * A handoff the courier has NOT submitted yet.
 *
 * The courier surface needs something genuinely unsubmitted, or "submit" is a
 * button that re-displays an existing record. Each draft is the final leg of
 * its own seeded shipment: every earlier leg is ingested at construction so the
 * custody chain is intact, and the last one is held back.
 *
 * It is the LAST leg specifically. Holding back a middle scan would break H1
 * for every leg after it, and the courier screen would be demonstrating a
 * custody-chain failure it did not intend to create.
 */
export type CourierDraft = {
  draftId: string;
  scenarioId: ScenarioId;
  title: string;
  epc: string;
  waybillNo: string;
  recipientAddress: string;
  leg: string;
  eventTime: string;
  eventId: string;
  /** What the courier has tried so far, oldest first. */
  attempts: { run: RunView; outcome: CourierOutcome }[];
};

type StoredDraft = CourierDraft & {
  built: BuiltEvent;
  scenario: GeneratedScenario;
  harness: IngestHarness;
  world: WorkbenchEntry["world"];
};

/**
 * Seed the independent records this leg's evidence refers to.
 *
 * MIRRORS `seedIdentityReferences` in lib/generate/ingest.ts, which is not
 * exported and which this session may not modify. Without it the held-back leg
 * would resolve a different evidence set from every other leg — I15 would come
 * back `not_evaluated` on the courier's submission and `clear` everywhere else
 * — so the screen would be showing an artefact of how the draft was built
 * rather than a property of the handoff. Duplicated deliberately and narrowly;
 * fold it back into one exported helper when lib/generate is in scope.
 */
function seedDraftIdentity(harness: IngestHarness, built: BuiltEvent): void {
  const identity = built.identity;
  if (!identity) return;

  const enrollment = identity.deviceEnrollment;
  harness.deps.db
    .insert(deviceEnrollments)
    .values({ ...enrollment, status: "active" })
    .onConflictDoNothing()
    .run();

  if (identity.otpChallenge) {
    harness.deps.db.insert(otpChallenges).values(identity.otpChallenge).onConflictDoNothing().run();
  }
}

/** Project a held-back leg into the courier's view of it. */
function makeDraft(
  id: ScenarioId,
  scenario: GeneratedScenario,
  world: WorkbenchEntry["world"],
  harness: IngestHarness,
  held: BuiltEvent,
): StoredDraft {
  seedDraftIdentity(harness, held);
  const epc = epcsOf(held.event)[0] ?? "";
  const parcel = scenario.parcels.find((candidate) => candidate.epc === epc);

  return {
    draftId: `DRAFT-${id}-${held.legIndex}`,
    scenarioId: id,
    title: DRAFT_TITLES[id] ?? "Delivery scan",
    epc,
    waybillNo: parcel?.waybillNo ?? "unknown",
    recipientAddress: parcel?.recipientAddress ?? "unknown",
    leg: held.leg,
    eventTime: held.event.eventTime,
    eventId: held.event.eventID,
    attempts: [],
    built: held,
    scenario,
    harness,
    world,
  };
}

export class OperatorWorkbench {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly drafts = new Map<string, StoredDraft>();
  private readonly harnesses = new Set<IngestHarness>();
  private actionSequence = 0;
  private readonly nowIso: string;

  constructor(entries: StoredEntry[], drafts: StoredDraft[] = []) {
    for (const entry of entries) {
      this.entries.set(entry.built.event.eventID, entry);
      this.harnesses.add(entry.harness);
    }
    for (const draft of drafts) {
      this.drafts.set(draft.draftId, draft);
      this.harnesses.add(draft.harness);
    }
    const latest = Math.max(...entries.map((entry) => Date.parse(entry.createdAt)));
    this.nowIso = new Date(latest + 12 * 60_000).toISOString();
  }

  /** Handoffs the courier has not submitted, plus whatever they have tried. */
  listCourierDrafts(): CourierDraft[] {
    // Named explicitly rather than rest-destructured: the harness, world and
    // built event must never reach a client component, and a spread would carry
    // any field a future edit adds to StoredDraft straight out of the server.
    return [...this.drafts.values()]
      .map((draft) => ({
        draftId: draft.draftId,
        scenarioId: draft.scenarioId,
        title: draft.title,
        epc: draft.epc,
        waybillNo: draft.waybillNo,
        recipientAddress: draft.recipientAddress,
        leg: draft.leg,
        eventTime: draft.eventTime,
        eventId: draft.eventId,
        attempts: draft.attempts,
      }))
      .sort((a, b) => a.draftId.localeCompare(b.draftId));
  }

  /**
   * Submit a draft as the courier would.
   *
   * `signed` false presents NO credential at all, which is session 16's
   * constitutive case: an absent courier signature decides nothing and writes
   * nothing. `signed` true presents a courier-only credential, which is
   * cryptographically valid and — on a handoff the gate says needs a
   * co-signature — still not enough to seal.
   *
   * Both paths run the SAME event through the SAME agent. Nothing about the
   * EPCIS payload changes between attempts, which is what makes the eventual
   * co-signed run a resubmission rather than a different handoff.
   */
  async submitAsCourier(
    draftId: string,
    options: { signed: boolean },
  ): Promise<{ draft: CourierDraft; run: RunView; outcome: CourierOutcome }> {
    const draft = this.drafts.get(draftId);
    if (!draft) throw new Error(`unknown draft ${draftId}`);

    const event = draft.built.event;
    const ctx = options.signed
      ? await ingestEvent(draft.harness, draft.built, {
          courierPrivateKey: draft.scenario.courier.keys.privateKey,
          mandateId: draft.scenario.courier.mandate.mandateId,
        })
      : await runAgent(event, {
          ...draft.harness.deps,
          now: () => new Date(Date.parse(event.recordTime ?? event.eventTime)),
          credential: undefined,
        });

    const run = runView(ctx, draft.attempts.length + 1, draft.built.event);
    const outcome = courierOutcome(run);
    draft.attempts.push({ run, outcome });

    this.promote(draft, ctx);
    return { draft: this.listCourierDrafts().find((d) => d.draftId === draftId)!, run, outcome };
  }

  /**
   * Give the operator the handoff once the courier has actually submitted it.
   *
   * A submission that wrote nothing still belongs in the queue when it is
   * waiting on a co-signature — that is the whole two-phase flow, and rule 3d
   * is explicit that PENDING means undecided rather than refused.
   *
   * AN UNSIGNED ATTEMPT MUST NOT ENTER THE QUEUE. Nobody is waiting on an
   * operator: the courier simply has not signed yet, and no operator action can
   * complete a credential whose first signature is absent. Queueing it would
   * hand an operator work they cannot action, which is a worse failure than
   * showing nothing — a queue that contains unactionable items stops being a
   * queue. The courier's own screen is where that submission belongs.
   */
  private promote(draft: StoredDraft, ctx: AgentContext): void {
    const eventId = draft.built.event.eventID;
    const existing = this.entries.get(eventId);
    if (existing) {
      existing.current = ctx;
      existing.runs.push(ctx);
      return;
    }

    const pendingCosign = ctx.halted?.reason === "PENDING_COSIGNATURE";
    const actionable = pendingCosign || (ctx.decision !== undefined && ctx.decision !== "accept");
    if (ctx.halted && !pendingCosign) return; // unsigned: nothing decided, nothing queued

    const state: CaseState | null = pendingCosign ? "awaiting_cosignature" : actionable ? "flagged" : null;
    const caseId = state ? `CASE-COURIER-${draft.scenarioId}-${draft.built.legIndex}` : null;
    const createdAt = draft.built.event.recordTime ?? draft.built.event.eventTime;

    const entry: StoredEntry = {
      scenario: draft.scenario,
      world: draft.world,
      built: draft.built,
      current: ctx,
      runs: [ctx],
      state,
      caseId,
      priority: priorityFor(state, ctx.decision),
      reason: reasonFor(ctx),
      createdAt,
      harness: draft.harness,
      actions: [],
    };
    this.entries.set(eventId, entry);

    if (state && caseId) {
      draft.harness.deps.db
        .insert(handoffCases)
        .values({
          caseId,
          eventId,
          scenarioId: draft.scenarioId,
          legIndex: draft.built.legIndex,
          state,
          priority: entry.priority,
          reason: entry.reason,
          payloadJson: JSON.stringify(draft.built.event),
          contextJson: JSON.stringify(ctx),
          traceJson: JSON.stringify(ctx.trace),
          createdAt,
          updatedAt: createdAt,
        })
        .onConflictDoNothing()
        .run();
    }
  }

  listQueue(): HandoffSummary[] {
    return [...this.entries.values()]
      .filter((entry) => entry.state !== null && isQueueState(entry.state))
      .map((entry) => summaryFrom(entry, this.nowIso))
      .sort((a, b) => b.priority - a.priority || b.ageMinutes - a.ageMinutes);
  }

  listHandoffs(): {
    summary: { automaticallyAccepted: number; total: number; timeframe: string; from: string; to: string };
    items: HandoffSummary[];
  } {
    const items = [...this.entries.values()]
      .map((entry) => summaryFrom(entry, this.nowIso))
      .sort((a, b) => Date.parse(b.eventTime) - Date.parse(a.eventTime));
    const times = items.map((item) => Date.parse(item.eventTime));
    const from = new Date(Math.min(...times)).toISOString();
    const to = new Date(Math.max(...times)).toISOString();
    return {
      summary: {
        automaticallyAccepted: items.filter((item) => item.decision === "accept" && item.sealed).length,
        total: items.length,
        timeframe: `${from} to ${to}`,
        from,
        to,
      },
      items,
    };
  }

  getHandoff(eventId: string): HandoffDetail | undefined {
    const entry = this.entries.get(eventId);
    if (!entry) return undefined;
    const summary = summaryFrom(entry, this.nowIso);
    const records = entry.harness.deps.ledger.readRecords();
    const timeline = [...this.entries.values()]
      .filter((candidate) => candidate.scenario.id === entry.scenario.id)
      .sort((a, b) => a.built.legIndex - b.built.legIndex)
      .map((candidate) => summaryFrom(candidate, this.nowIso));
    return {
      summary,
      event: entry.built.event,
      flags: flagsFrom(entry.current),
      gate: {
        decision: entry.current.gateResult?.decision ?? entry.current.decision ?? null,
        matrixCell: entry.current.gateResult?.matrixCell ?? null,
        rationale: entry.current.gateResult?.rationale ?? null,
        cosignReasons: entry.current.gateResult?.cosignReasons ?? [],
      },
      credential: runView(entry.current, entry.runs.length, entry.built.event).credential,
      ledger: {
        sequence: entry.current.ledger?.status === "recorded" ? entry.current.ledger.seq : null,
        chainValid: entry.harness.deps.ledger.verifyChain().valid,
        entries: records.length,
      },
      runs: entry.runs.map((ctx, index) => runView(ctx, index + 1, entry.built.event)),
      actions: [...entry.actions],
      timeline,
      map: buildShipmentMapModel(entry.scenario, entry.world),
      plan: {
        selectedTools: entry.current.plan?.tools ?? [],
        source: entry.current.plan
          ? entry.current.planFromHeuristic
            ? "heuristic"
            : "model"
          : "unavailable",
        rejection: entry.current.planRejection ?? null,
      },
      externalContext: entry.current.externalContext ?? null,
      reroute: entry.current.reroute ?? null,
      explanation: {
        text: entry.current.explanation ?? null,
        source: entry.current.explanation
          ? entry.current.explanationFromFallback
            ? "fallback"
            : "model"
          : "unavailable",
        rejection: entry.current.explanationRejection ?? null,
      },
    };
  }

  async resolveHandoff(eventId: string, rawRequest: ActionRequest): Promise<HandoffDetail> {
    const request = OperatorActionRequest.parse(rawRequest);
    const entry = this.entries.get(eventId);
    if (!entry || !entry.state || !entry.caseId) throw new Error("handoff is not actionable");
    const fromState = entry.state;
    const toState = transitionCase(fromState, request.action);

    if (request.action === "approve") {
      const approved = await ingestEvent(entry.harness, entry.built, {
        courierPrivateKey: entry.scenario.courier.keys.privateKey,
        mandateId: entry.scenario.courier.mandate.mandateId,
        withCosign: true,
      });
      if (approved.halted || !approved.verdict) throw new Error("completed credential did not seal");
      entry.current = approved;
      entry.runs.push(approved);
      entry.reason = approved.gateResult?.rationale ?? "Approved with an operator co-signature.";
    }

    if (request.action === "propose_reroute" && entry.current.reroute?.status !== "proposed") {
      throw new Error("no authorised reroute exists for this handoff");
    }

    const createdAt = new Date(Date.parse(this.nowIso) + ++this.actionSequence * 1_000).toISOString();
    const action: ActionView = {
      action: request.action,
      note: request.note ?? null,
      operatorId: OPERATOR_ID,
      fromState,
      toState,
      createdAt,
    };
    entry.actions.push(action);
    entry.state = toState;
    entry.priority = priorityFor(toState, entry.current.decision);

    entry.harness.deps.db.transaction((tx) => {
      tx.insert(operatorActions)
        .values({
          actionId: `${entry.caseId}-${String(this.actionSequence).padStart(3, "0")}`,
          caseId: entry.caseId!,
          ...action,
        })
        .run();
      tx.update(handoffCases)
        .set({
          state: toState,
          priority: entry.priority,
          reason: entry.reason,
          contextJson: JSON.stringify(entry.current),
          traceJson: JSON.stringify(entry.current.trace),
          runCount: entry.runs.length,
          updatedAt: createdAt,
          resolvedAt: toState.startsWith("resolved_") ? createdAt : null,
        })
        .where(eq(handoffCases.caseId, entry.caseId!))
        .run();
    });

    return this.getHandoff(eventId)!;
  }

  /** Narrow test seam for proving a courier submission wrote nothing. */
  debugDraftHandle(draftId: string): { db: VigilDb } {
    const draft = this.drafts.get(draftId);
    if (!draft) throw new Error(`unknown draft ${draftId}`);
    return { db: draft.harness.deps.db };
  }

  /** Narrow test seam for proving actions cannot rewrite verdict rows. */
  debugHandle(eventId: string): { db: VigilDb } {
    const entry = this.entries.get(eventId);
    if (!entry) throw new Error("unknown handoff");
    return { db: entry.harness.deps.db };
  }

  close(): void {
    for (const harness of this.harnesses) {
      closeDb(harness.deps.db);
      rmSync(harness.dir, { recursive: true, force: true });
    }
  }
}

export async function createWorkbench(
  options: { scenarioIds?: ScenarioId[]; courierDrafts?: boolean } = {},
): Promise<OperatorWorkbench> {
  const ids = options.scenarioIds ?? SCENARIO_IDS;
  /**
   * Drafts are on for the app and off for a test that pins its scenarios.
   *
   * Reserving S1's delivery leg means the operator's queue does NOT contain a
   * pending co-signature until a courier submits one — which is the real flow,
   * and exactly what four 17A tests assert against at construction. Those tests
   * pin `scenarioIds`, so they keep the pre-courier behaviour unchanged and
   * this feature does not reach into them. A test that wants a draft asks.
   */
  const wantDrafts = options.courierDrafts ?? options.scenarioIds === undefined;

  const groups: StoredEntry[][] = [];
  const drafts: StoredDraft[] = [];
  for (const id of ids) {
    const built = await buildScenarioEntries(id, {
      holdBackFinalLeg: wantDrafts && id in DRAFT_TITLES,
    });
    groups.push(built.entries);
    if (built.draft) drafts.push(built.draft);
  }

  return new OperatorWorkbench(groups.flat(), drafts);
}

declare global {
  var __vigilOperatorWorkbench: Promise<OperatorWorkbench> | undefined;
}

/** Process-long state: Next route modules share this rather than regenerating per request. */
export function getWorkbench(): Promise<OperatorWorkbench> {
  globalThis.__vigilOperatorWorkbench ??= createWorkbench();
  return globalThis.__vigilOperatorWorkbench;
}

import { eq } from "drizzle-orm";
import { runAgent } from "@/lib/agent/machine";
import { sha256Hex } from "@/lib/ledger";
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
  type GeneratedWorld,
  type IngestHarness,
  type ScenarioId,
} from "@/lib/generate";
import { buildRequestedScenario, type BuildRequest } from "@/lib/generate/builder";
import { ADDRESSES, jitterPoint, type GeneratedParcel } from "@/lib/generate/world";
import { createOpenMeteoProvider, OPEN_METEO_CACHE_DIR } from "@/lib/weather";
import { epcsOf } from "@/lib/epcis";
import { rmSync } from "node:fs";
import { OperatorActionRequest, type CaseState, type OperatorActionRequest as ActionRequest } from "./types";
import { isQueueState, transitionCase } from "./state";
import { buildShipmentMapModel } from "./map-model";
import { courierOutcome, type CourierOutcome } from "./courier";
import { considerTools } from "@/lib/llm/plan";
import { recipientChannelFingerprint } from "@/lib/identity/channel";
import {
  answerConfirmation,
  expireConfirmations,
  issueConfirmation,
  tokenStateOf,
  type RecipientAnswer,
  type TokenState,
} from "@/lib/recipient";
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
/**
 * How long a recipient has to answer their confirmation link.
 *
 * ASSUMPTION, not a measurement. Two days is long enough to cover a working
 * weekend and short enough that silence means something. Nothing scores the
 * silence today, so this bound currently decides only when the row stops
 * saying "waiting".
 */
const CONFIRMATION_WINDOW_HOURS = 48;

const DRAFT_TITLES: Partial<Record<ScenarioId, string>> = {
  S1: "Delivery scan — needs an operator co-signature",
  S0: "Delivery scan — ordinary work",
};
const START_MS = Date.parse("2026-09-07T14:30:00+08:00");
const OPERATOR_ID = "OP-01";

type StoredEntry = WorkbenchEntry & { harness: IngestHarness; actions: ActionView[] };

/**
 * A correction the sender made after the parcel was already moving.
 *
 * Real state with a real timestamp — and, importantly, state NO DETECTOR READS.
 * The operator's explanation is assembled from it; the engine's verdict is not.
 * That separation is what keeps the demonstration honest: the flag has to fall
 * out of the registry being stale, not out of anyone being told.
 */
export type AddressCorrection = {
  fromLabel: string;
  toLabel: string;
  toIndex: number;
  toPoint: { latitude: number; longitude: number };
  correctedAt: string;
};

type BuiltShipment = {
  runId: string;
  /** Kept so the run can be rebuilt byte-identically with a delivery override. */
  request: BuildRequest;
  scenario: GeneratedScenario;
  world: GeneratedWorld;
  harness: IngestHarness;
  /** The delivery leg, built but not yet run. */
  held: BuiltEvent;
  parcel: GeneratedParcel;
  route: { origin: { label: string } };
  correction?: AddressCorrection;
  deliveryEventId?: string;
};

export type SenderShipmentView = {
  runId: string;
  waybillNo: string;
  originLabel: string;
  /** The delivery point OF RECORD — unchanged by a correction, which is the point. */
  recordedAddress: string;
  declaredValueSen: number;
  correction?: AddressCorrection;
  delivered: boolean;
  deliveryEventId: string | null;
};

/** One stored entry, built the same way the boot path builds them. */
function storedEntryFor(shipment: BuiltShipment, built: BuiltEvent, ctx: AgentContext): StoredEntry {
  const pending = ctx.halted?.reason === "PENDING_COSIGNATURE";
  const actionable = pending || (ctx.decision !== undefined && ctx.decision !== "accept");
  const state: CaseState | null = pending ? "awaiting_cosignature" : actionable ? "flagged" : null;

  return {
    scenario: shipment.scenario,
    world: shipment.world,
    built,
    current: ctx,
    runs: [ctx],
    state,
    caseId: state ? `CASE-${shipment.runId}-${built.legIndex}` : null,
    priority: priorityFor(state, ctx.decision),
    reason: reasonFor(ctx),
    createdAt: built.event.recordTime ?? built.event.eventTime,
    harness: shipment.harness,
    actions: [],
  };
}

/** Who is acting, and the key that proves it. */
export type RoleIdentity = {
  role: "courier" | "operator" | "recipient" | "sender";
  label: string;
  subject: string;
  /** Short form of a REAL Ed25519 public key, or null when none applies. */
  keyFingerprint: string | null;
  /**
   * Why there is no key, for the parties that do not hold one.
   *
   * A BLANK WOULD BE A WORSE ANSWER THAN AN EXPLANATION. Sender and recipient
   * are structurally different from courier and operator: they supply
   * declarations, and signatures come from the parties who take actions. Saying
   * so on the strip states the argument while identifying the user — the same
   * job the fingerprint does for the other two.
   */
  note?: string;
};

/**
 * A readable short form of a public key: a HASH of it, not a truncation.
 *
 * The first attempt sliced the base64 directly and produced `ed25519:MCow…T1CY`
 * for the courier and `ed25519:MCow…WPoI` for the operator. Those differ, but
 * only in the last four characters — `MCow` is the DER header every Ed25519
 * SPKI key carries, so on a paused video frame both strips read as the same
 * identity. A fingerprint whose leading characters are constant across all keys
 * is not a fingerprint.
 *
 * Hashing first is also what the convention is: SSH shows `SHA256:` of the key
 * for exactly this reason. Every character now varies with the key.
 */
function fingerprint(publicKey: string | undefined): string | null {
  if (!publicKey) return null;
  const digest = sha256Hex(publicKey);
  return `ed25519:${digest.slice(0, 4)}…${digest.slice(4, 8)}`;
}

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
  source: ScenarioId | { scenario: GeneratedScenario; world: GeneratedWorld },
  options: {
    holdBackFinalLeg?: boolean;
    /**
     * Which leg is submitted COURIER-ONLY, so the gate gets to ask for a
     * co-signature and the case lands in the operator's queue.
     *
     * Authored scenarios name their own leg. A built run passes the delivery
     * leg, which makes "pending" DERIVED from what the gate decided rather than
     * declared in advance: a shipment whose declared value crosses the
     * mandate's co-sign figure halts and waits for an operator; one that does
     * not, seals. Same submission either way.
     */
    leavePendingAt?: (built: BuiltEvent, scenario: GeneratedScenario) => boolean;
  } = {},
): Promise<{ entries: StoredEntry[]; draft?: StoredDraft }> {
  // A pre-built scenario travels the IDENTICAL path from here on. The scenario
  // builder composes a `GeneratedScenario` and hands it over; nothing below
  // knows or cares whether it was authored or requested. Session 7's lesson:
  // the second code path is always the one without the tests.
  const world = typeof source === "string" ? buildWorld(SEED) : source.world;
  const scenario =
    typeof source === "string"
      ? buildScenario(source, { world, rng: makeRng(SEED), startMs: START_MS })
      : source.scenario;
  const id = scenario.id;
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
    const leavePending = options.leavePendingAt
      ? options.leavePendingAt(built, scenario)
      : (id === "S1" || id === "S5") && built.leg === scenario.expectation.exceptionAtLeg;
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
  /** Sender-created shipments whose delivery scan has not happened yet. */
  private readonly shipments = new Map<string, BuiltShipment>();
  /** tokenId -> the handoff it asks about. */
  private readonly confirmations = new Map<string, StoredEntry>();
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
    this.issueConfirmations();
  }

  /**
   * Issue one recipient capability per sealed delivery.
   *
   * Only deliveries, and only sealed ones: there is nothing to confirm about a
   * depot scan, and asking about a handoff that decided nothing would be asking
   * a recipient to adjudicate a pending co-signature.
   */
  private issueConfirmations(): void {
    for (const entry of this.entries.values()) {
      const ctx = entry.current;
      const sealed = ctx.ledger?.status === "recorded" || ctx.ledger?.status === "noop";
      if (!sealed) continue;
      if (entry.built.leg !== "delivery") continue;

      const event = ctx.event ?? entry.built.event;
      const epc = epcsOf(event)[0] ?? "";
      const parcel = entry.scenario.parcels.find((candidate) => candidate.epc === epc);
      if (!parcel?.recipientPhone) continue;

      const tokenId = issueConfirmation(entry.harness.deps.db, {
        eventId: event.eventID,
        epc,
        // The SAME channel record I15 checks a delivery against, so "we have an
        // independent line to the recipient" is a fact rather than a claim.
        channelFingerprint: recipientChannelFingerprint(parcel.recipientPhone),
        issuedAt: entry.createdAt,
        windowHours: CONFIRMATION_WINDOW_HOURS,
      });
      this.confirmations.set(tokenId, entry);
    }
  }

  /** The recipient link for one handoff, for the operator viewing that handoff. */
  confirmationFor(eventId: string): { tokenId: string; state: TokenState } | undefined {
    for (const [tokenId, entry] of this.confirmations) {
      if (entry.built.event.eventID !== eventId) continue;
      return { tokenId, state: tokenStateOf(entry.harness.deps.db, tokenId, this.nowIso) };
    }
    return undefined;
  }

  /**
   * What the recipient sees when they open their link.
   *
   * `nowIso` is returned alongside the state because the caller needs to say
   * how long is left, and that answer must come from the instant this status
   * was judged against — not from the caller's own clock.
   */
  getConfirmation(tokenId: string): {
    state: TokenState;
    waybillNo: string | null;
    nowIso: string;
  } {
    const entry = this.confirmations.get(tokenId);
    if (!entry) return { state: { status: "unknown" }, waybillNo: null, nowIso: this.nowIso };

    const epc = epcsOf(entry.built.event)[0] ?? "";
    const parcel = entry.scenario.parcels.find((candidate) => candidate.epc === epc);
    return {
      state: tokenStateOf(entry.harness.deps.db, tokenId, this.nowIso),
      waybillNo: parcel?.waybillNo ?? null,
      nowIso: this.nowIso,
    };
  }

  /** Record the recipient's answer, writing a dispute when they say it never came. */
  answerConfirmation(tokenId: string, answer: RecipientAnswer) {
    const entry = this.confirmations.get(tokenId);
    if (!entry) return { ok: false as const, state: { status: "unknown" as const } };
    return answerConfirmation(entry.harness.deps.db, tokenId, answer, this.nowIso);
  }

  /** Close out unanswered links whose window has passed. Records silence; scores nothing. */
  expireConfirmations(nowIso: string = this.nowIso): number {
    let closed = 0;
    for (const harness of this.harnesses) closed += expireConfirmations(harness.deps.db, nowIso);
    return closed;
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
   * Run a shipment the viewer composed, and say where to look at it.
   *
   * This is the scenario builder's only entry point into the workbench, and it
   * reuses `buildScenarioEntries` wholesale — the same ingest, the same
   * `runAgent`, the same entry construction, the same case rows. What arrives
   * is an ordinary `GeneratedScenario`; nothing downstream knows it was
   * requested rather than authored.
   *
   * The final leg is submitted COURIER-ONLY, so whether it waits for an
   * operator is DERIVED from the gate rather than declared here: a declared
   * value over the mandate's co-sign figure halts and queues, and one under it
   * seals. Same submission, different outcome, for a reason the sender caused.
   */
  async runBuilt(
    request: BuildRequest,
    options: { holdDelivery?: boolean } = {},
  ): Promise<
    | { ok: true; runId: string; eventIds: string[]; landOnEventId: string | null; inTransit: boolean }
    | { ok: false; reason: string }
  > {
    const world = buildWorld(SEED);
    const built = buildRequestedScenario(request, { world, startMs: START_MS });
    if (!built.ok) return { ok: false, reason: built.reason };

    const { entries } = await buildScenarioEntries(
      { scenario: built.scenario, world },
      {
        holdBackFinalLeg: options.holdDelivery,
        leavePendingAt: (event, scenario) =>
          event.legIndex === scenario.timeline.length - 1,
      },
    );

    for (const entry of entries) {
      this.entries.set(entry.built.event.eventID, entry);
      this.harnesses.add(entry.harness);
    }

    if (options.holdDelivery) {
      // The parcel is out for delivery and the delivery scan has not happened.
      // That gap is what makes a mid-route correction possible at all: a
      // correction after the fact is a data-entry fix, not a stale record.
      const parcel = built.scenario.parcels[0];
      const held = built.scenario.timeline[built.scenario.timeline.length - 1];

      this.shipments.set(built.runId, {
        runId: built.runId,
        request,
        scenario: built.scenario,
        world,
        harness: entries[0].harness,
        held,
        parcel,
        route: built.route,
        correction: undefined,
        deliveryEventId: undefined,
      });
    }

    // Land on the leg that is actually worth looking at: whatever the gate
    // stopped on, or the delivery if it accepted everything.
    const exception = entries.find((entry) => entry.state !== null);
    const last = entries[entries.length - 1];

    return {
      ok: true,
      runId: built.runId,
      inTransit: Boolean(options.holdDelivery),
      eventIds: entries.map((entry) => entry.built.event.eventID),
      landOnEventId: options.holdDelivery ? null : (exception ?? last).built.event.eventID,
    };
  }

  /**
   * The sender corrects the recipient address after dispatch.
   *
   * ORDINARY BUSINESS, NOT A FAULT. A customer moves, a flat number was wrong,
   * a building has two entrances. This lives in the product half of the sender
   * surface for that reason — the demo-control panel is for things a merchant
   * would never do.
   *
   * WHAT IT DOES AND DELIBERATELY DOES NOT DO. It records the correction, with
   * the time it was made. It does NOT rewrite `parcels.recipient_lat/lng`, and
   * it tells the engine nothing. The delivery point OF RECORD is the one
   * captured at dispatch; the correction reaches the courier out of band, the
   * way a phone call does, and the registry has not been reconciled to it.
   *
   * **That unreconciled gap IS the stale record.** Nothing downstream is
   * informed that a correction happened: I10/I11 simply compare where the scan
   * was taken against the coordinate on file and find they disagree. If the
   * engine had to be told, the demonstration would be circular — a system
   * detecting a condition it was handed.
   *
   * Session 10 measured this as the LEADING false-positive contributor at noise
   * level 1. Known Limitations states it as a sentence; this makes it a thing
   * you can watch happen.
   */
  correctAddress(
    runId: string,
    addressIndex: number,
  ): { ok: true; correction: AddressCorrection } | { ok: false; reason: string } {
    const shipment = this.shipments.get(runId);
    if (!shipment) {
      return { ok: false, reason: "No shipment in transit under that reference." };
    }
    if (shipment.deliveryEventId) {
      return {
        ok: false,
        reason:
          "This parcel has already been delivered. Correcting the address now would be a " +
          "data-entry fix after the fact, not a record the delivery was measured against.",
      };
    }

    const address = ADDRESSES[addressIndex];
    if (!address) return { ok: false, reason: "That address is not on file." };
    if (address.label === shipment.parcel.recipientAddress) {
      return { ok: false, reason: "That is already the address on record." };
    }

    const correction: AddressCorrection = {
      fromLabel: shipment.parcel.recipientAddress,
      toLabel: address.label,
      toIndex: addressIndex,
      // The courier's doorstep at the new address, derived the same way the
      // registry derives one: the geocoded centroid is not the door.
      toPoint: jitterPoint(makeRng(`${runId}::correction`), address, 60),
      correctedAt: this.nowIso,
    };

    shipment.correction = correction;
    return { ok: true, correction };
  }

  /**
   * The courier delivers. To the corrected address, if there was a correction.
   *
   * The scan is INTERNALLY CONSISTENT at wherever the courier actually is —
   * position, serving cell and access point all agree, because the courier is
   * genuinely standing there. Moving the position without moving the observed
   * sites would manufacture an I1 contradiction that nobody committed, and the
   * whole point of this case is that the courier did nothing wrong.
   *
   * The only thing that disagrees is the registry.
   */
  async completeDelivery(
    runId: string,
  ): Promise<{ ok: true; eventId: string } | { ok: false; reason: string }> {
    const shipment = this.shipments.get(runId);
    if (!shipment) return { ok: false, reason: "No shipment in transit under that reference." };
    if (shipment.deliveryEventId) {
      return { ok: false, reason: "This parcel has already been delivered." };
    }

    const correction = shipment.correction;
    let built = shipment.held;

    if (correction) {
      // POSITION, CELL AND WIFI MOVE TOGETHER. The courier is genuinely at the
      // new address, so the scan is internally consistent there. Moving the
      // position while still reporting the old address's tower would fire I1 on
      // a contradiction nobody committed — turning an honest delivery into an
      // apparent spoof and destroying the distinction this case exists to draw.
      const sites = shipment.world.sitesByAddress[correction.toIndex];
      const rebuilt = buildRequestedScenario(shipment.request, {
        world: shipment.world,
        startMs: START_MS,
        deliveryOverride: {
          scanPoint: correction.toPoint,
          cellSiteId: sites.cell,
          wifiBssid: sites.wifi,
        },
      });
      if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason };
      built = rebuilt.scenario.timeline[rebuilt.scenario.timeline.length - 1];
    }

    const ctx = await ingestEvent(shipment.harness, built, {
      courierPrivateKey: shipment.scenario.courier.keys.privateKey,
      mandateId: shipment.scenario.courier.mandate.mandateId,
    });

    const entry = storedEntryFor(shipment, built, ctx);
    this.entries.set(built.event.eventID, entry);
    shipment.deliveryEventId = built.event.eventID;

    return { ok: true, eventId: built.event.eventID };
  }

  /** Shipments the sender has dispatched, for their own surface. */
  listSenderShipments(): SenderShipmentView[] {
    return [...this.shipments.values()].map((shipment) => ({
      runId: shipment.runId,
      waybillNo: shipment.parcel.waybillNo,
      originLabel: shipment.route.origin.label,
      recordedAddress: shipment.parcel.recipientAddress,
      declaredValueSen: shipment.parcel.declaredValueSen,
      correction: shipment.correction,
      delivered: Boolean(shipment.deliveryEventId),
      deliveryEventId: shipment.deliveryEventId ?? null,
    }));
  }

  /** The correction behind a delivery, for the operator's explanation. */
  correctionFor(eventId: string): AddressCorrection | null {
    for (const shipment of this.shipments.values()) {
      if (shipment.deliveryEventId === eventId) return shipment.correction ?? null;
    }
    return null;
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
      /**
       * The recipient's link for THIS handoff, and only this one.
       *
       * A DEMO AFFORDANCE: in production the link is delivered to the
       * recipient's own channel and is never displayed to staff, because it is
       * the whole credential. Scoped to the handoff already on screen rather
       * than offered as a listing, which would hand out every capability at
       * once. See Known Limitations.
       */
      recipientConfirmation: this.confirmationFor(eventId) ?? null,
      addressCorrection: (() => {
        const correction = this.correctionFor(eventId);
        return correction
          ? {
              fromLabel: correction.fromLabel,
              toLabel: correction.toLabel,
              correctedAt: correction.correctedAt,
            }
          : null;
      })(),
      ledger: {
        sequence: entry.current.ledger?.status === "recorded" ? entry.current.ledger.seq : null,
        chainValid: entry.harness.deps.ledger.verifyChain().valid,
        entries: records.length,
      },
      runs: entry.runs.map((ctx, index) => runView(ctx, index + 1, entry.built.event)),
      actions: [...entry.actions],
      timeline,
      map: buildShipmentMapModel(entry.scenario, entry.world),
      planConsidered: considerTools(entry.current),
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

  /**
   * Who the demo is acting as, with the fingerprint of the key that signs.
   *
   * THE FINGERPRINT IS OF A REAL KEY. `scenario.courier.keys.publicKey` is the
   * Ed25519 key that actually signs the courier's submissions, and
   * `harness.operator.publicKey` is the one that actually co-signs. A decorative
   * hex string on a page arguing that THE KEY IS THE IDENTITY would be the same
   * class of invention as plotting `not_evaluated` at the origin or giving an
   * unlocated flag a map marker — a claim dressed as a measurement. See rule 3e.
   */
  identities(): { courier: RoleIdentity; operator: RoleIdentity; sender: RoleIdentity } {
    const entry = [...this.entries.values()][0] ?? [...this.drafts.values()][0];
    const courier = entry?.scenario.courier;

    return {
      courier: {
        role: "courier",
        label: courier?.displayName ?? "Courier",
        subject: courier?.courierId ?? "unknown",
        keyFingerprint: fingerprint(courier?.keys.publicKey),
      },
      operator: {
        role: "operator",
        label: "Ops Console",
        subject: OPERATOR_ID,
        keyFingerprint: fingerprint(entry?.harness.operator.publicKey),
      },
      sender: {
        role: "sender",
        label: "Merchant despatch",
        subject: "SENDER-01",
        keyFingerprint: null,
        note:
          "No signing key — the sender's declarations are claims, verified against what the " +
          "courier and recipient independently report.",
      },
    };
  }

  /**
   * The limits a sender's declaration is measured against.
   *
   * READ FROM THE MANDATE, never restated. The form tells a viewer that a
   * declared value above this figure will require a co-signature, and that
   * sentence has to come from the same place the gate reads — otherwise it is a
   * second copy of the rule and the two part company the first time the mandate
   * moves (rule 3g).
   */
  senderPolicy(): { cosignOverSen: number | null; codCapSen: number; maxValueSen: number; courier: string } {
    const entry = [...this.entries.values()][0] ?? [...this.drafts.values()][0];
    const mandate = entry?.scenario.courier.mandate;
    const cosign = mandate?.requiresCosignIf.find((rule) => rule.kind === "parcel_value_over_sen");

    return {
      cosignOverSen: cosign?.value ?? null,
      codCapSen: mandate?.limits.codCashCapSen ?? 0,
      maxValueSen: mandate?.limits.maxParcelValueSen ?? 0,
      courier: entry?.scenario.courier.displayName ?? "the assigned courier",
    };
  }

  /**
   * Where one scenario's ledger file lives, for the browser-side verifier.
   *
   * Returns a PATH, not contents and not a verdict. The route reads the bytes
   * and hands them over unexamined; anything else would mean the server
   * vouching for the file a visitor came to check for themselves.
   */
  ledgerSource(scenarioId?: string): { scenarioId: string; path: string } | undefined {
    for (const entry of this.entries.values()) {
      if (scenarioId && entry.scenario.id !== scenarioId) continue;
      return { scenarioId: entry.scenario.id, path: entry.harness.deps.ledger.path };
    }
    return undefined;
  }

  /** Every scenario that has a ledger to verify. */
  ledgerScenarios(): string[] {
    return [...new Set([...this.entries.values()].map((entry) => entry.scenario.id))].sort();
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

import { and, eq } from "drizzle-orm";
import { runAgent } from "@/lib/agent/machine";
import { canonicalHash, sha256Hex, type AbortRecord } from "@/lib/ledger";
import type { AgentContext } from "@/lib/agent/context";
import type { TraceFrame } from "@/lib/agent/trace";
import { closeDb, type VigilDb } from "@/lib/db/client";
import { dispatchRequests, handoffCases, operatorActions } from "@/lib/db/schema";
import {
  SCENARIO_IDS,
  buildScenario,
  buildWorld,
  createHarness,
  ingestEvent,
  ingestWithApproval,
  makeRng,
  recordDispute,
  seedIdentityReferences,
  seedFleetBackground,
  upsertScenarioParcels,
  type BuiltEvent,
  type GeneratedScenario,
  type GeneratedWorld,
  type IngestHarness,
  type ScenarioId,
} from "@/lib/generate";
import { buildRequestedScenario, runIdFor, type BuildRequest } from "@/lib/generate/builder";
import { resolveRoute, type Route } from "@/lib/generate/route";
import { ADDRESSES, jitterPoint, type GeneratedParcel } from "@/lib/generate/world";
import { createOpenMeteoProvider, OPEN_METEO_CACHE_DIR } from "@/lib/weather";
import { createMigratedDb } from "@/lib/db/migrate";
import {
  addressClaimOf,
  addressLabelOf,
  appendCorrection,
  boundaryLabel,
  buildOnlineScenario,
  createShipment,
  getShipment,
  loadServiceBoundary,
  recordSimulatedScan,
  resolvedOf,
  shipmentStorePath,
  UNREGISTERED_LOCATION_GAP,
  COORDINATE_DECIMALS,
  type LocationInput,
  type LocationSnapshot,
  type Point,
  type DepotRoute,
  type ServiceBoundary,
  type ShipmentRequest,
} from "@/lib/shipment";
import { epcsOf } from "@/lib/epcis";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { OperatorActionRequest, type CaseState, type OperatorActionRequest as ActionRequest } from "./types";
import { isQueueState, transitionCase } from "./state";
import { buildShipmentMapModel, type MapLocation } from "./map-model";
import { courierOutcome, type CourierOutcome } from "./courier";
import { considerTools } from "@/lib/llm/plan";
import { activeAgentLlm, bootstrapAgentLlm, resolveRuntimeLlm, type RuntimeLlm } from "@/lib/llm/runtime";
import { recipientChannelFingerprint } from "@/lib/identity/channel";
import { EvidenceStore, type EvidenceReply } from "./evidence-store";
import type { DispatchWorkspace, DispatchItem, CourierEvidenceItem, EvidenceRequestView } from "./operations-types";
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
  checksFrom,
  runView,
  summaryFrom,
  type ActionView,
  type HandoffDetail,
  type HandoffSummary,
  type HandoffState,
  type RouteLocationView,
  type ShipmentRouteView,
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

type StoredEntry = WorkbenchEntry & {
  harness: IngestHarness;
  actions: ActionView[];
  /** The append-only seal survived, but the case/audit transaction needs retry. */
  pendingApprovalAudit?: ActionRequest;
};

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
  route: Route;
  correction?: AddressCorrection;
  deliveryEventId?: string;
  submittedBuilt?: BuiltEvent;
  attempts: CourierDraft["attempts"];
};

export type SenderShipmentView = {
  assignmentState?: "awaiting_assignment" | "assigned";
  assignedCourier?: string | null;
  kind?: "registered" | "online";
  shipmentId?: string;
  runId: string;
  waybillNo: string;
  originLabel: string;
  /** The delivery point OF RECORD — unchanged by a correction, which is the point. */
  recordedAddress: string;
  declaredValueSen: number;
  correction?: Omit<AddressCorrection, "toIndex"> & { toIndex?: number };
  delivered: boolean;
  deliveryEventId: string | null;
  recordedPoint?: { latitude: number; longitude: number };
  fault?: BuildRequest["fault"];
};

/**
 * An online shipment's RUN in this process.
 *
 * The shipment and its locations are rows in the durable store; this is not.
 * The harness, the held delivery leg and the signing keys live here, and a
 * restart loses them. Restartable workflow is a separate scope — see Known
 * Limitations — so nothing below pretends a stored shipment can be resumed by a
 * process that did not start it.
 */
type OnlineRun = {
  runId: string;
  shipmentId: string;
  scenario: GeneratedScenario;
  world: GeneratedWorld;
  harness: IngestHarness;
  route: DepotRoute;
  deliveryEventId?: string;
  submittedBuilt?: BuiltEvent;
  submittedPoint?: Point;
  attempts: CourierDraft["attempts"];
};

/** Which boundary a point was checked against, said on every answer that involves one. */
export type BoundaryNote = {
  version: string;
  placeholder: boolean;
  /** The ODbL attribution for a real boundary, or the pending-confirmation line. */
  label: string;
  extractedAt: string | null;
};

export type OnlineCreateResult = { boundary: BoundaryNote } & (
  | { status: "created" | "replayed"; shipmentId: string; running: true; eventIds: string[] }
  | { status: "replayed"; shipmentId: string; running: false; reason: string }
  | { status: "created" | "replayed"; shipmentId: string; running: false; awaitingAssignment: true; eventIds: string[] }
  | { status: "conflict"; reason: string }
  | { status: "rejected"; field: "origin" | "destination"; code: string; reason: string }
);

/** One stored entry, built the same way the boot path builds them. */
function storedEntryFor(
  shipment: { runId: string; scenario: GeneratedScenario; world: GeneratedWorld; harness: IngestHarness },
  built: BuiltEvent,
  ctx: AgentContext,
): StoredEntry {
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

/** Persist the mutable operator case that belongs to a stored delivery entry. */
function persistStoredCase(entry: StoredEntry): void {
  if (!entry.state || !entry.caseId) return;

  entry.harness.deps.db
    .insert(handoffCases)
    .values({
      caseId: entry.caseId,
      eventId: entry.built.event.eventID,
      scenarioId: entry.scenario.id,
      legIndex: entry.built.legIndex,
      state: entry.state,
      priority: entry.priority,
      reason: entry.reason,
      payloadJson: JSON.stringify(entry.built.event),
      contextJson: JSON.stringify(entry.current),
      traceJson: JSON.stringify(entry.current.trace),
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
    })
    .onConflictDoNothing()
    .run();
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
  if (state === "evidence_submitted") return 450;
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
    llm?: IngestHarness["deps"]["llm"];
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
  harness.deps.llm = options.llm;
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
      // S5's timed_out is chosen by scenario id above, not by any timer.
      ...(state === "timed_out" ? { stateSource: "seeded" as const } : {}),
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
  /** The distinct operator act that completed this credential, if it happened. */
  operatorSeal: {
    operatorId: string;
    createdAt: string;
    ledgerStatus: "recorded" | "noop";
  } | null;
};

export type CourierQueueItem = {
  identity?: RoleIdentity;
  currentRun?: RunView;
  state?: HandoffState;
  handoffId: string;
  source: "seeded" | "registered" | "online";
  courierId: string;
  scenarioId: string;
  runId: string;
  title: string;
  epc: string;
  waybillNo: string;
  route: ShipmentRouteView;
  leg: string;
  eventTime: string;
  eventId: string;
  fault: BuildRequest["fault"] | null;
  attempts: CourierDraft["attempts"];
  operatorSeal: CourierDraft["operatorSeal"];
};

export type CourierWorkspaceView = {
  couriers?: RoleIdentity[];
  evidenceRequests?: CourierEvidenceItem[];
  identity: RoleIdentity;
  items: CourierQueueItem[];
};

export type CourierSubmissionResult = {
  item: CourierQueueItem;
  run: RunView;
  outcome: CourierOutcome;
};

function registeredLocation(label: string): RouteLocationView {
  return { label, source: "registered", coordinate: null, senderClaim: null };
}

function registeredPointLocation(label: string, point: Point): RouteLocationView {
  return {
    label,
    source: "registered",
    coordinate: `${point.latitude.toFixed(COORDINATE_DECIMALS)}, ${point.longitude.toFixed(COORDINATE_DECIMALS)}`,
    senderClaim: null,
  };
}

function storedLocation(snapshot: LocationSnapshot): RouteLocationView {
  const coordinate = `${snapshot.latitude.toFixed(COORDINATE_DECIMALS)}, ${snapshot.longitude.toFixed(COORDINATE_DECIMALS)}`;
  const senderClaim = addressClaimOf(snapshot);
  const resolved = resolvedOf(snapshot);

  if (resolved) {
    return {
      label: resolved.label,
      source: resolved.by === "search" ? "geocoder_search" : "geocoder_reverse",
      coordinate,
      senderClaim,
    };
  }
  if (senderClaim) return { label: senderClaim, source: "sender_claim", coordinate, senderClaim };
  return { label: coordinate, source: "coordinate", coordinate, senderClaim: null };
}

type StoredDraft = CourierDraft & {
  built: BuiltEvent;
  scenario: GeneratedScenario;
  harness: IngestHarness;
  world: WorkbenchEntry["world"];
};

/**
 * Seed the independent records this leg's evidence refers to.
 *
 * The shared generator helper is required here as well as during ingest.
 * Without it the held-back leg would resolve a different evidence set from
 * every other leg: I15 would become `not_evaluated` on the courier submission
 * and `clear` elsewhere, an artefact of reconstruction rather than the handoff.
 */

/** Project a held-back leg into the courier's view of it. */
function makeDraft(
  id: ScenarioId,
  scenario: GeneratedScenario,
  world: WorkbenchEntry["world"],
  harness: IngestHarness,
  held: BuiltEvent,
): StoredDraft {
  seedIdentityReferences(harness, held);
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
    operatorSeal: null,
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
  /** Online shipments with a run in THIS process, by shipment id. */
  private readonly online = new Map<string, OnlineRun>();
  private onlineStore?: VigilDb;
  private onlineBoundary: ServiceBoundary | null | undefined;
  private actionSequence = 0;
  private readonly nowIso: string;
  private dispatchWorld?: GeneratedWorld;
  private readonly assigning = new Set<string>();
  private readonly reviewing = new Set<string>();
  private readonly workflowIds = new WeakMap<IngestHarness, string>();

  constructor(entries: StoredEntry[], drafts: StoredDraft[] = [], private readonly runtimeLlm: RuntimeLlm = resolveRuntimeLlm()) {
    for (const entry of entries) {
      this.entries.set(entry.built.event.eventID, entry);
      this.harnesses.add(entry.harness);
    }
    // Historical seeded records keep the explicit bootstrap-skip provenance
    // already sealed in their contexts. Any later operator action on the same
    // harness is interactive and may use the selected runtime provider.
    for (const harness of this.harnesses) harness.deps.llm = activeAgentLlm(this.runtimeLlm);
    for (const draft of drafts) {
      draft.harness.deps.llm = activeAgentLlm(this.runtimeLlm);
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
    for (const entry of this.entries.values()) this.issueConfirmationFor(entry);
  }

  private issueConfirmationFor(entry: StoredEntry): void {
    const ctx = entry.current;
    const sealed = ctx.ledger?.status === "recorded" || ctx.ledger?.status === "noop";
    if (!sealed || entry.built.leg !== "delivery") return;

    const event = ctx.event ?? entry.built.event;
    const epc = epcsOf(event)[0] ?? "";
    const parcel = entry.scenario.parcels.find((candidate) => candidate.epc === epc);
    if (!parcel?.recipientPhone) return;

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
      .map((draft) => {
        const entry = this.entries.get(draft.eventId);
        const approval = entry?.actions.find((action) => action.action === "approve");
        const approvedRun = entry?.runs.find(
          (ctx) =>
            ctx.credential?.validSignatures.includes("operator") &&
            (ctx.ledger?.status === "recorded" || ctx.ledger?.status === "noop"),
        );
        return {
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
        operatorSeal: approval && approvedRun && (approvedRun.ledger?.status === "recorded" || approvedRun.ledger?.status === "noop")
          ? {
              operatorId: approval.operatorId,
              createdAt: approval.createdAt,
              ledgerStatus: approvedRun.ledger.status,
            }
          : null,
        };
      })
      .sort((a, b) => a.draftId.localeCompare(b.draftId));
  }

  /**
   * The courier workspace is one identity, not a mixed fleet listing.
   *
   * S1 is the seeded handoff used by the co-sign demonstration. Sender-built
   * and online shipments are deliberately assigned to the same generated
   * courier, so it is the stable identity for this demo workspace. If a pinned
   * test does not include S1, fall back to a courier that actually exists in
   * that workbench rather than inventing one.
   */
  private fleetWorld(): GeneratedWorld {
    this.dispatchWorld ??= [...this.entries.values()][0]?.world ?? [...this.drafts.values()][0]?.world ?? buildWorld(SEED);
    return this.dispatchWorld;
  }

  private courierIdentity(courier: GeneratedWorld["couriers"][number]): RoleIdentity {
    return { role: "courier", label: courier.displayName, subject: courier.courierId, keyFingerprint: fingerprint(courier.keys.publicKey) };
  }

  private courierCurrentView(eventId: string): Pick<CourierQueueItem, "currentRun" | "state"> {
    const entry = this.entries.get(eventId);
    if (!entry) return {};
    const number = Math.max(1, entry.runs.findIndex((run) => run === entry.current) + 1);
    return { currentRun: runView(entry.current, number, entry.built.event), state: entry.state ?? "accepted" };
  }

  private evidenceStore(): EvidenceStore { return new EvidenceStore(this.store()); }

  private workflowId(harness: IngestHarness): string {
    let id = this.workflowIds.get(harness);
    if (!id) { id = randomUUID(); this.workflowIds.set(harness, id); }
    return id;
  }

  private committedEvidenceRequests(entry: StoredEntry): number {
    if (!entry.caseId) return 0;
    return entry.harness.deps.db.select({ id: operatorActions.actionId }).from(operatorActions)
      .where(and(eq(operatorActions.caseId, entry.caseId), eq(operatorActions.action, "request_evidence"))).all().length;
  }

  private publishedEvidence(entry: StoredEntry): EvidenceRequestView[] {
    const rounds = this.evidenceStore().list(entry.built.event.eventID, this.workflowId(entry.harness));
    return rounds.slice(0, this.committedEvidenceRequests(entry));
  }

  private unpublishedEvidenceIntent(entry: StoredEntry): EvidenceRequestView | undefined {
    const rounds = this.evidenceStore().list(entry.built.event.eventID, this.workflowId(entry.harness));
    return rounds[this.committedEvidenceRequests(entry)];
  }

  dispatchWorkspace(): DispatchWorkspace {
    const couriers = this.fleetWorld().couriers.map((courier) => this.courierIdentity(courier));
    const items: DispatchItem[] = this.store().select().from(dispatchRequests).all().map((row) => {
      const live = row.source === "online" ? this.online.has(row.dispatchId.slice(7)) : this.shipments.has(row.dispatchId.slice(11));
      if (row.source === "online") {
        const history = getShipment(this.store(), row.dispatchId.slice(7))!;
        return { dispatchId: row.dispatchId, source: row.source,
          waybillNo: `WB-ON-${history.shipment.shipmentId.slice(0, 8).toUpperCase()}`,
          originLabel: storedLocation(history.origin).label, destinationLabel: storedLocation(history.currentReference).label,
          originDepot: history.shipment.originDepot, destinationDepot: history.shipment.destinationDepot,
          declaredValueSen: history.shipment.declaredValueSen, state: row.state, courierId: row.courierId,
          createdAt: row.createdAt, available: row.state === "awaiting_assignment" || live };
      }
      const request = JSON.parse(row.requestJson) as BuildRequest;
      const route = resolveRoute(request);
      return { dispatchId: row.dispatchId, source: row.source, waybillNo: `WB-BUILT-${row.dispatchId.slice(13).toUpperCase()}`,
        originLabel: route.origin.label, destinationLabel: route.destination.label,
        originDepot: route.originHub.label, destinationDepot: route.destinationHub.label, declaredValueSen: request.declaredValueSen,
        state: row.state, courierId: row.courierId, createdAt: row.createdAt, available: row.state === "awaiting_assignment" || live };
    });
    return { couriers, items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.dispatchId.localeCompare(b.dispatchId)) };
  }

  queueRegisteredShipment(request: BuildRequest) {
    if (!ADDRESSES[request.originIndex] || !ADDRESSES[request.destinationIndex]) return { ok: false as const, reason: "Choose collection and delivery addresses from the registered set." };
    if (request.fault === "batch_scan") return { ok: false as const, reason: "Batch scanning needs multiple parcels; use the seeded S2 scenario." };
    resolveRoute(request);
    const runId = runIdFor(request);
    const dispatchId = `registered:${runId}`;
    const existing = this.store().select().from(dispatchRequests).where(eq(dispatchRequests.dispatchId, dispatchId)).get();
    if (existing?.state === "assigned" || this.shipments.has(runId)) return { ok: false as const, reason: "This exact shipment has already been dispatched. Change a declaration to create a different shipment; an earlier assigned workflow is not restarted." };
    this.store().insert(dispatchRequests).values({ dispatchId, source: "registered", requestJson: JSON.stringify(request),
      state: "awaiting_assignment", createdAt: this.nowIso }).onConflictDoNothing().run();
    return { ok: true as const, runId, eventIds: [], landOnEventId: null, inTransit: false, awaitingAssignment: true };
  }

  async assignDispatch(dispatchId: string, courierId: string): Promise<DispatchWorkspace> {
    const world = this.fleetWorld();
    const courierIndex = world.couriers.findIndex((courier) => courier.courierId === courierId);
    if (courierIndex < 0) throw new Error("Unknown courier; no assignment was made.");
    const row = this.store().select().from(dispatchRequests).where(eq(dispatchRequests.dispatchId, dispatchId)).get();
    if (!row) throw new Error("No shipment awaiting assignment under that reference.");
    if (row.state !== "awaiting_assignment" || this.assigning.has(dispatchId)) throw new Error("This shipment is already assigned.");
    this.assigning.add(dispatchId);
    const claimed = this.store().update(dispatchRequests).set({ state: "assigned", courierId, assignedAt: this.nowIso })
      .where(and(eq(dispatchRequests.dispatchId, dispatchId), eq(dispatchRequests.state, "awaiting_assignment"))).run();
    if (!claimed.changes) { this.assigning.delete(dispatchId); throw new Error("This shipment is already assigned."); }
    try {
      if (row.source === "online") {
        const history = getShipment(this.store(), dispatchId.slice(7));
        if (!history) throw new Error("The confirmed shipment locations are unavailable.");
        await this.startOnlineRun(history, world, courierIndex);
      } else {
        const result = await this.runBuilt(JSON.parse(row.requestJson) as BuildRequest, { holdDelivery: true, courierIndex, world });
        if (!result.ok) throw new Error(result.reason);
      }
    } catch (error) {
      this.store().update(dispatchRequests).set({ state: "awaiting_assignment", courierId: null, assignedAt: null })
        .where(eq(dispatchRequests.dispatchId, dispatchId)).run();
      throw error;
    } finally { this.assigning.delete(dispatchId); }
    return this.dispatchWorkspace();
  }

  private courierEvidence(courierId: string): CourierEvidenceItem[] {
    for (const entry of this.entries.values()) {
      if (entry.scenario.courier.courierId === courierId) this.reconcileEvidenceReceipt(entry);
    }
    return [...this.entries.values()].filter((entry) => entry.scenario.courier.courierId === courierId)
      .flatMap((entry) => this.publishedEvidence(entry).map((request) => {
        const epc = epcsOf(entry.built.event)[0];
        const parcel = entry.scenario.parcels.find((p) => p.epc === epc);
        return { request, waybillNo: summaryFrom(entry, this.nowIso).parcel.waybillNo,
          route: this.routeFor(entry.built.event.eventID) ?? { origin: null, destination: registeredLocation(parcel?.recipientAddress ?? "Not recorded") },
          identity: this.courierIdentity(entry.scenario.courier), findings: flagsFrom(entry.current).map(({ id, label }) => ({ id, label })),
          state: entry.state ?? "accepted" };
      }));
  }

  courierWorkspace(courierId?: string): CourierWorkspaceView {
    const preferred = [...this.drafts.values()].find((draft) => draft.scenarioId === "S1");
    const fallbackOwner = preferred?.scenario.courier ??
      [...this.shipments.values()][0]?.scenario.courier ??
      [...this.online.values()][0]?.scenario.courier ??
      [...this.drafts.values()][0]?.scenario.courier;
    const owner = courierId ? this.fleetWorld().couriers.find((courier) => courier.courierId === courierId) : fallbackOwner;
    if (courierId && !owner) throw new Error("Unknown courier.");

    const identity: RoleIdentity = {
      role: "courier",
      label: owner?.displayName ?? "Courier",
      subject: owner?.courierId ?? "unknown",
      keyFingerprint: fingerprint(owner?.keys.publicKey),
    };
    const couriers = this.fleetWorld().couriers.map((courier) => this.courierIdentity(courier));
    if (!owner) return { identity, items: [], couriers, evidenceRequests: [] };

    const seeded: CourierQueueItem[] = [...this.drafts.values()]
      .filter((draft) => draft.scenario.courier.courierId === owner.courierId)
      .map((draft) => ({
        handoffId: `seeded:${draft.draftId}`,
        source: "seeded",
        courierId: draft.scenario.courier.courierId,
        identity: this.courierIdentity(draft.scenario.courier),
        scenarioId: draft.scenarioId,
        runId: draft.scenarioId,
        title: draft.title,
        epc: draft.epc,
        waybillNo: draft.waybillNo,
        route: { origin: null, destination: registeredLocation(draft.recipientAddress) },
        leg: draft.leg,
        eventTime: draft.eventTime,
        eventId: draft.eventId,
        fault: null,
        attempts: draft.attempts,
        operatorSeal: this.operatorSealFor(draft.eventId),
        ...this.courierCurrentView(draft.eventId),
      }));

    const registered: CourierQueueItem[] = [...this.shipments.values()]
      .filter((shipment) => shipment.scenario.courier.courierId === owner.courierId)
      .map((shipment) => ({
        handoffId: `registered:${shipment.runId}`,
        source: "registered",
        courierId: shipment.scenario.courier.courierId,
        identity: this.courierIdentity(shipment.scenario.courier),
        scenarioId: shipment.scenario.id,
        runId: shipment.runId,
        title: "Delivery scan — sender dispatch",
        epc: shipment.parcel.epc,
        waybillNo: shipment.parcel.waybillNo,
        route: {
          origin: registeredLocation(shipment.route.origin.label),
          destination: registeredLocation(shipment.correction?.toLabel ?? shipment.parcel.recipientAddress),
        },
        leg: shipment.held.leg,
        eventTime: shipment.held.event.eventTime,
        eventId: shipment.held.event.eventID,
        fault: shipment.request.fault,
        attempts: shipment.attempts,
        operatorSeal: this.operatorSealFor(shipment.deliveryEventId),
        ...this.courierCurrentView(shipment.held.event.eventID),
      }));

    const online: CourierQueueItem[] = [...this.online.values()]
      .filter((run) => run.scenario.courier.courierId === owner.courierId)
      .map((run) => {
        const history = getShipment(this.store(), run.shipmentId)!;
        const parcel = run.scenario.parcels[0];
        const held = run.scenario.timeline[run.scenario.timeline.length - 1];
        return {
          handoffId: `online:${run.shipmentId}`,
          source: "online" as const,
          courierId: run.scenario.courier.courierId,
          identity: this.courierIdentity(run.scenario.courier),
          scenarioId: run.scenario.id,
          runId: run.runId,
          title: "Delivery scan — point-to-point dispatch",
          epc: parcel.epc,
          waybillNo: parcel.waybillNo,
          route: {
            origin: storedLocation(history.origin),
            destination: storedLocation(history.currentReference),
          },
          leg: held.leg,
          eventTime: held.event.eventTime,
          eventId: held.event.eventID,
          fault: null,
          attempts: run.attempts,
          operatorSeal: this.operatorSealFor(run.deliveryEventId),
          ...this.courierCurrentView(held.event.eventID),
        };
      });

    const sourceOrder = { registered: 0, online: 1, seeded: 2 } as const;
    return {
      identity,
      couriers,
      evidenceRequests: this.courierEvidence(owner.courierId),
      items: [...registered, ...online, ...seeded].sort(
        (a, b) => sourceOrder[a.source] - sourceOrder[b.source] || a.handoffId.localeCompare(b.handoffId),
      ),
    };
  }

  /** Identity for the handoff selected by a multi-shipment presentation surface. */
  identityForHandoff(eventId: string): RoleIdentity | undefined {
    const entry = this.entries.get(eventId);
    const draft = [...this.drafts.values()].find((candidate) => candidate.eventId === eventId);
    const shipment = [...this.shipments.values()].find((candidate) => candidate.held.event.eventID === eventId);
    const online = [...this.online.values()].find((candidate) => {
      const held = candidate.scenario.timeline[candidate.scenario.timeline.length - 1];
      return held?.event.eventID === eventId;
    });
    const courier = entry?.scenario.courier ?? draft?.scenario.courier ?? shipment?.scenario.courier ?? online?.scenario.courier;
    if (!courier) return undefined;
    return {
      role: "courier",
      label: courier.displayName,
      subject: courier.courierId,
      keyFingerprint: fingerprint(courier.keys.publicKey),
    };
  }

  private operatorSealFor(eventId: string | undefined): CourierDraft["operatorSeal"] {
    if (!eventId) return null;
    const entry = this.entries.get(eventId);
    const approval = entry?.actions.find((action) => action.action === "approve");
    const approvedRun = entry?.runs.find(
      (ctx) =>
        ctx.credential?.validSignatures.includes("operator") &&
        (ctx.ledger?.status === "recorded" || ctx.ledger?.status === "noop"),
    );
    return approval && approvedRun && (approvedRun.ledger?.status === "recorded" || approvedRun.ledger?.status === "noop")
      ? { operatorId: approval.operatorId, createdAt: approval.createdAt, ledgerStatus: approvedRun.ledger.status }
      : null;
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

    const { run, outcome } = await this.submitSeededDraft(draft, options);
    return { draft: this.listCourierDrafts().find((item) => item.draftId === draftId)!, run, outcome };
  }

  private async runCourierSubmission(
    target: Pick<StoredDraft, "built" | "scenario" | "harness">,
    options: { signed: boolean },
    runNumber: number,
  ): Promise<{ ctx: AgentContext; run: RunView; outcome: CourierOutcome }> {
    const event = target.built.event;
    const ctx = options.signed
      ? await ingestEvent(target.harness, target.built, {
          courierPrivateKey: target.scenario.courier.keys.privateKey,
          mandateId: target.scenario.courier.mandate.mandateId,
        })
      : await runAgent(event, {
          ...target.harness.deps,
          now: () => new Date(Date.parse(event.recordTime ?? event.eventTime)),
          credential: undefined,
        });

    const run = runView(ctx, runNumber, target.built.event);
    return { ctx, run, outcome: courierOutcome(run) };
  }

  private async submitSeededDraft(
    draft: StoredDraft,
    options: { signed: boolean },
  ): Promise<{ run: RunView; outcome: CourierOutcome }> {
    const { ctx, run, outcome } = await this.runCourierSubmission(draft, options, draft.attempts.length + 1);
    draft.attempts.push({ run, outcome });
    this.promote(draft, ctx);
    return { run, outcome };
  }

  /**
   * Submit any prepared delivery through one courier-facing contract.
   *
   * Each source still owns how its final EPCIS event is assembled. From that
   * point onward the credential, agent, ledger and outcome path are identical.
   * That boundary is deliberate: forcing three different location models into
   * one builder would erase facts, while keeping three submission paths is what
   * let the sender-created work disappear from the courier page.
   */
  async submitCourierHandoff(
    handoffId: string,
    options: { signed: boolean; simulatedScan?: Point; courierId?: string },
  ): Promise<CourierSubmissionResult> {
    const dispatch = this.store().select().from(dispatchRequests).where(eq(dispatchRequests.dispatchId, handoffId)).get();
    if (dispatch && (dispatch.state !== "assigned" || this.assigning.has(handoffId))) throw new Error("A courier must be assigned before this handoff can be submitted.");
    const owner = this.courierOwnerFor(handoffId);
    if (options.courierId && owner?.courierId !== options.courierId) throw new Error("Only the assigned courier can sign this handoff.");
    const separator = handoffId.indexOf(":");
    const source = handoffId.slice(0, separator);
    const sourceId = separator >= 0 ? handoffId.slice(separator + 1) : "";

    if (source === "seeded") {
      const draft = this.drafts.get(sourceId);
      if (!draft) throw new Error(`unknown courier handoff ${handoffId}`);
      const { run, outcome } = await this.submitSeededDraft(draft, options);
      return { item: this.courierQueueItem(handoffId), run, outcome };
    }

    if (source === "registered") {
      const shipment = this.shipments.get(sourceId);
      if (!shipment) throw new Error(`unknown courier handoff ${handoffId}`);
      const built = shipment.submittedBuilt ?? this.registeredDeliveryEvent(shipment);
      const { ctx, run, outcome } = await this.runCourierSubmission(
        { built, scenario: shipment.scenario, harness: shipment.harness },
        options,
        shipment.attempts.length + 1,
      );
      shipment.attempts.push({ run, outcome });
      if (options.signed) {
        this.promoteSenderDelivery(shipment, built, ctx);
      }
      return { item: this.courierQueueItem(handoffId), run, outcome };
    }

    if (source === "online") {
      const online = this.online.get(sourceId);
      if (!online) throw new Error(`unknown courier handoff ${handoffId}`);
      const prepared = this.onlineDeliveryEvent(online, options.simulatedScan);
      if (options.signed && !online.deliveryEventId) {
        recordSimulatedScan(this.store(), { shipmentId: online.shipmentId, point: prepared.point, nowIso: this.nowIso });
      }
      const { ctx, run, outcome } = await this.runCourierSubmission(
        { built: prepared.built, scenario: online.scenario, harness: online.harness },
        options,
        online.attempts.length + 1,
      );
      online.attempts.push({ run, outcome });
      if (options.signed) this.promoteOnlineDelivery(online, prepared.built, prepared.point, ctx);
      return { item: this.courierQueueItem(handoffId), run, outcome };
    }

    throw new Error(`unknown courier handoff ${handoffId}`);
  }

  private courierQueueItem(handoffId: string): CourierQueueItem {
    const owner = this.courierOwnerFor(handoffId);
    const item = this.courierWorkspace(owner?.courierId).items.find((candidate) => candidate.handoffId === handoffId);
    if (!item) throw new Error(`courier handoff ${handoffId} is not assigned to the acting courier`);
    return item;
  }

  private courierOwnerFor(handoffId: string) {
    const sourceId = handoffId.slice(handoffId.indexOf(":") + 1);
    return handoffId.startsWith("seeded:") ? this.drafts.get(sourceId)?.scenario.courier
      : handoffId.startsWith("online:") ? this.online.get(sourceId)?.scenario.courier
      : this.shipments.get(sourceId)?.scenario.courier;
  }

  private registeredDeliveryEvent(shipment: BuiltShipment): BuiltEvent {
    if (!shipment.correction) return shipment.held;

    const sites = shipment.world.sitesByAddress[shipment.correction.toIndex];
    const rebuilt = buildRequestedScenario(shipment.request, {
      world: shipment.world,
      startMs: START_MS,
      courierIndex: shipment.world.couriers.findIndex((c) => c.courierId === shipment.scenario.courier.courierId),
      deliveryOverride: {
        scanPoint: shipment.correction.toPoint,
        cellSiteId: sites.cell,
        wifiBssid: sites.wifi,
      },
    });
    if (!rebuilt.ok) throw new Error(rebuilt.reason);
    return rebuilt.scenario.timeline[rebuilt.scenario.timeline.length - 1];
  }

  private onlineDeliveryEvent(run: OnlineRun, scan?: Point): { built: BuiltEvent; point: Point } {
    if (run.submittedBuilt && run.submittedPoint) return { built: run.submittedBuilt, point: run.submittedPoint };

    const history = getShipment(this.store(), run.shipmentId)!;
    const point = scan ?? { latitude: history.currentReference.latitude, longitude: history.currentReference.longitude };
    const rebuilt = buildOnlineScenario(history, { world: run.world, startMs: START_MS, scan: point,
      courierIndex: run.world.couriers.findIndex((c) => c.courierId === run.scenario.courier.courierId) });
    return { built: rebuilt.scenario.timeline[rebuilt.scenario.timeline.length - 1], point };
  }

  private promoteSenderDelivery(shipment: BuiltShipment, built: BuiltEvent, ctx: AgentContext): void {
    const existing = shipment.deliveryEventId ? this.entries.get(shipment.deliveryEventId) : undefined;
    if (existing) {
      existing.runs.push(ctx);
      // A duplicate is an attempt against the already sealed handoff, not a
      // new authoritative result. Its sparse context belongs in history only.
      if (ctx.ledger?.status !== "noop") existing.current = ctx;
      this.issueConfirmationFor(existing);
      return;
    }
    const entry = storedEntryFor(shipment, built, ctx);
    persistStoredCase(entry);
    this.entries.set(built.event.eventID, entry);
    shipment.deliveryEventId = built.event.eventID;
    shipment.submittedBuilt = built;
    this.issueConfirmationFor(entry);
  }

  private promoteOnlineDelivery(run: OnlineRun, built: BuiltEvent, point: Point, ctx: AgentContext): void {
    const existing = run.deliveryEventId ? this.entries.get(run.deliveryEventId) : undefined;
    if (existing) {
      existing.runs.push(ctx);
      if (ctx.ledger?.status !== "noop") existing.current = ctx;
      this.issueConfirmationFor(existing);
      return;
    }
    const entry = storedEntryFor(run, built, ctx);
    persistStoredCase(entry);
    this.entries.set(built.event.eventID, entry);
    run.deliveryEventId = built.event.eventID;
    run.submittedBuilt = built;
    run.submittedPoint = point;
    this.issueConfirmationFor(entry);
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
    options: { holdDelivery?: boolean; courierIndex?: number; world?: GeneratedWorld } = {},
  ): Promise<
    | { ok: true; runId: string; eventIds: string[]; landOnEventId: string | null; inTransit: boolean }
    | { ok: false; reason: string }
  > {
    const world = options.world ?? buildWorld(SEED);
    const built = buildRequestedScenario(request, { world, startMs: START_MS, courierIndex: options.courierIndex });
    if (!built.ok) return { ok: false, reason: built.reason };

    /**
     * THE SAME REQUEST TWICE IS THE SAME SHIPMENT, not a second one.
     *
     * Run ids are derived from the request, so an identical request re-derives
     * identical event ids — and the workbench keys entries by event id, so a
     * second run would silently overwrite the first, taking any operator action
     * recorded against it along with it. Rule 1g's defect 4 again, reached by
     * repetition instead of by seeding. Refuse, and say how to get a fresh one.
     */
    const existing = built.scenario.timeline.find((leg) => this.entries.has(leg.event.eventID));
    if (existing) {
      return {
        ok: false,
        reason:
          `This exact shipment (${built.runId}) has already been dispatched in this process. ` +
          "Change any declaration to create a different one, or restart the server to replay it.",
      };
    }

    const { entries } = await buildScenarioEntries(
      { scenario: built.scenario, world },
      {
        holdBackFinalLeg: options.holdDelivery,
        leavePendingAt: (event, scenario) =>
          event.legIndex === scenario.timeline.length - 1,
        llm: bootstrapAgentLlm(this.runtimeLlm),
      },
    );

    for (const entry of entries) {
      this.entries.set(entry.built.event.eventID, entry);
      this.harnesses.add(entry.harness);
      this.issueConfirmationFor(entry);
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
        submittedBuilt: undefined,
        attempts: [],
      });
      entries[0].harness.deps.llm = activeAgentLlm(this.runtimeLlm);
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

    const submitted = await this.submitCourierHandoff(`registered:${runId}`, { signed: true });
    return { ok: true, eventId: submitted.item.eventId };
  }

  /** Shipments the sender has dispatched, for their own surface. */
  listSenderShipments(): SenderShipmentView[] {
    const assignments = this.store().select().from(dispatchRequests).all();
    const awaiting: SenderShipmentView[] = this.dispatchWorkspace().items.filter((item) => item.state === "awaiting_assignment").map((item) => ({
      kind: item.source, shipmentId: item.source === "online" ? item.dispatchId.slice(7) : undefined,
      runId: item.source === "online" ? `B-O-${item.dispatchId.slice(7)}` : item.dispatchId.slice(11),
      waybillNo: item.waybillNo, originLabel: item.originLabel, recordedAddress: item.destinationLabel,
      declaredValueSen: item.declaredValueSen, delivered: false, deliveryEventId: null,
      assignmentState: "awaiting_assignment", assignedCourier: null,
    }));
    const registered = [...this.shipments.values()].map((shipment) => ({
      kind: "registered" as const,
      runId: shipment.runId,
      waybillNo: shipment.parcel.waybillNo,
      originLabel: shipment.route.origin.label,
      recordedAddress: shipment.parcel.recipientAddress,
      declaredValueSen: shipment.parcel.declaredValueSen,
      correction: shipment.correction,
      delivered: Boolean(shipment.deliveryEventId),
      deliveryEventId: shipment.deliveryEventId ?? null,
      fault: shipment.request.fault,
    }));
    const online = [...this.online.values()].map((run) => {
      const history = getShipment(this.store(), run.shipmentId)!;
      const lastCorrection = history.corrections.at(-1);
      const parcel = run.scenario.parcels[0];
      return {
        kind: "online" as const,
        shipmentId: run.shipmentId,
        runId: run.runId,
        waybillNo: parcel.waybillNo,
        originLabel: addressLabelOf(history.origin),
        recordedAddress: addressLabelOf(history.originalReference),
        ...(lastCorrection ? { correction: {
          fromLabel: addressLabelOf(history.originalReference),
          toLabel: addressLabelOf(lastCorrection.to),
          toPoint: { latitude: lastCorrection.to.latitude, longitude: lastCorrection.to.longitude },
          correctedAt: lastCorrection.correctedAt,
        } } : {}),
        recordedPoint: {
          latitude: history.originalReference.latitude,
          longitude: history.originalReference.longitude,
        },
        declaredValueSen: parcel.declaredValueSen,
        delivered: Boolean(run.deliveryEventId),
        deliveryEventId: run.deliveryEventId ?? null,
      };
    });
    return [...awaiting, ...registered, ...online].map((item) => {
      const dispatchId = item.kind === "online" ? `online:${item.shipmentId}` : `registered:${item.runId}`;
      const assignment = assignments.find((row) => row.dispatchId === dispatchId);
      return { ...item, assignmentState: assignment?.state ?? "assigned", assignedCourier: assignment?.courierId ?? "CR-1001" };
    });
  }

  /**
   * Point the online surface at a store and a boundary. Tests pass an in-memory
   * store and a fixture boundary; the app opens the durable file and reads the
   * confirmed boundary lazily on first use.
   */
  configureOnline(options: { store: VigilDb; boundary: ServiceBoundary | null }): void {
    this.onlineStore = options.store;
    this.onlineBoundary = options.boundary;
  }

  private store(): VigilDb {
    this.onlineStore ??= createMigratedDb(shipmentStorePath());
    return this.onlineStore;
  }

  private boundary(): ServiceBoundary | null {
    if (this.onlineBoundary === undefined) this.onlineBoundary = loadServiceBoundary();
    return this.onlineBoundary;
  }

  /** The boundary in force, as a surface should describe it. */
  boundaryNote(): BoundaryNote {
    const boundary = this.boundary();
    if (!boundary) {
      return { version: "none", placeholder: false, label: "No service-area boundary is configured", extractedAt: null };
    }
    return {
      version: boundary.version,
      placeholder: Boolean(boundary.placeholder),
      label: boundaryLabel(boundary),
      extractedAt: boundary.extractedAt ?? null,
    };
  }

  /**
   * Create a shipment from two points the sender confirmed, and run it up to
   * out-for-delivery. The delivery scan is held: it is a separate act by the
   * courier, and that gap is what makes a correction possible.
   *
   * A replayed request returns the same shipment. If this process already runs
   * it, the caller gets the same run; if not — the server restarted since — the
   * answer says so rather than starting a second run under the same event ids or
   * pretending the old one survived.
   */
  async createOnlineShipment(request: ShipmentRequest, idempotencyKey: string, options: { awaitAssignment?: boolean } = {}): Promise<OnlineCreateResult> {
    const result = createShipment(this.store(), {
      request,
      idempotencyKey,
      boundary: this.boundary(),
      nowIso: this.nowIso,
    });
    const boundary = this.boundaryNote();
    if (result.status === "conflict" || result.status === "rejected") return { ...result, boundary };

    const shipmentId = result.shipment.shipmentId;
    const dispatchId = `online:${shipmentId}`;
    const dispatch = this.store().select().from(dispatchRequests).where(eq(dispatchRequests.dispatchId, dispatchId)).get();
    if ((options.awaitAssignment && result.status === "created") || dispatch?.state === "awaiting_assignment") {
      this.store().insert(dispatchRequests).values({ dispatchId, source: "online", requestJson: "{}", state: "awaiting_assignment", createdAt: this.nowIso }).onConflictDoNothing().run();
      return { status: result.status, shipmentId, running: false, awaitingAssignment: true, eventIds: [], boundary };
    }
    const existing = this.online.get(shipmentId);
    if (existing) {
      return { status: result.status, shipmentId, running: true, eventIds: this.eventIdsOf(existing), boundary };
    }
    if (result.status === "replayed") {
      return {
        boundary,
        status: "replayed",
        shipmentId,
        running: false,
        reason:
          "This shipment is on file, but its run belonged to an earlier server process. The locations " +
          "are kept; the workflow is not restartable, so it is not resumed here.",
      };
    }

    const history = getShipment(this.store(), shipmentId)!;
    await this.startOnlineRun(history, buildWorld(SEED));
    return { status: "created", shipmentId, running: true, eventIds: this.eventIdsOf(this.online.get(shipmentId)!), boundary };
  }

  private async startOnlineRun(history: NonNullable<ReturnType<typeof getShipment>>, world: GeneratedWorld, courierIndex?: number): Promise<void> {
    const shipmentId = history.shipment.shipmentId;
    const built = buildOnlineScenario(history, { world, startMs: START_MS, courierIndex });
    const { scenario } = built;
    const { entries } = await buildScenarioEntries(
      { scenario, world },
      {
        holdBackFinalLeg: true,
        leavePendingAt: (event, s) => event.legIndex === s.timeline.length - 1,
        llm: bootstrapAgentLlm(this.runtimeLlm),
      },
    );
    for (const entry of entries) {
      this.entries.set(entry.built.event.eventID, entry);
      this.harnesses.add(entry.harness);
    }
    const run: OnlineRun = {
      runId: scenario.id,
      shipmentId,
      scenario,
      world,
      harness: entries[0].harness,
      route: built.route,
      submittedBuilt: undefined,
      submittedPoint: undefined,
      attempts: [],
    };
    run.harness.deps.llm = activeAgentLlm(this.runtimeLlm);
    this.online.set(shipmentId, run);
  }

  private eventIdsOf(run: OnlineRun): string[] {
    return [...this.entries.values()]
      .filter((entry) => entry.scenario.id === run.runId)
      .sort((a, b) => a.built.legIndex - b.built.legIndex)
      .map((entry) => entry.built.event.eventID);
  }

  /**
   * Append a correction to the delivery reference. The original point stays on
   * the parcel and in the store, and nothing tells the engine (session 20's
   * stale-record behaviour, unchanged).
   *
   * Refused after delivery, and refused when this process has no run for the
   * shipment: whether it was delivered is run state, and a correction that might
   * postdate the delivery it explains must not be written (rule 3g).
   */
  correctOnlineShipment(
    shipmentId: string,
    to: LocationInput,
  ): { ok: true; sequence: number } | { ok: false; code: string; reason: string } {
    const run = this.online.get(shipmentId);
    if (!run) {
      return {
        ok: false,
        code: "no_run",
        reason: "No run for this shipment in this process, so whether it was delivered cannot be told.",
      };
    }
    if (run.deliveryEventId) {
      return {
        ok: false,
        code: "delivered",
        reason:
          "This parcel has already been delivered. A correction now would be written after the scan it " +
          "would explain.",
      };
    }
    const result = appendCorrection(this.store(), { shipmentId, to, boundary: this.boundary(), nowIso: this.nowIso });
    return result.ok ? { ok: true, sequence: result.correction.sequence } : result;
  }

  /**
   * The simulated courier scans the delivery.
   *
   * `scan` is a SIMULATION INPUT and is recorded as one. Omitted, the courier
   * stands at the current delivery reference — the point they were sent to. It
   * never changes the reference the scan is measured against.
   */
  async deliverOnlineShipment(
    shipmentId: string,
    scan?: Point,
  ): Promise<{ ok: true; eventId: string } | { ok: false; code: string; reason: string }> {
    const run = this.online.get(shipmentId);
    if (!run) return { ok: false, code: "no_run", reason: "No run for this shipment in this process." };
    if (run.deliveryEventId) return { ok: false, code: "delivered", reason: "This parcel has already been delivered." };
    const submitted = await this.submitCourierHandoff(`online:${shipmentId}`, {
      signed: true,
      simulatedScan: scan,
    });
    return { ok: true, eventId: submitted.item.eventId };
  }

  /** The stored history for the sender's own surface, and whether this process runs it. */
  onlineShipment(shipmentId: string) {
    const history = getShipment(this.store(), shipmentId);
    if (!history) return undefined;
    const run = this.online.get(shipmentId);
    return {
      history,
      running: Boolean(run),
      delivered: Boolean(run?.deliveryEventId),
      deliveryEventId: run?.deliveryEventId ?? null,
    };
  }

  private onlineRunFor(eventId: string): OnlineRun | undefined {
    const entry = this.entries.get(eventId);
    if (!entry) return undefined;
    return [...this.online.values()].find((run) => run.runId === entry.scenario.id);
  }

  private routeFor(eventId: string): ShipmentRouteView | null {
    const entry = this.entries.get(eventId);
    if (!entry) return null;

    const online = [...this.online.values()].find((run) => run.runId === entry.scenario.id);
    if (online) {
      const history = getShipment(this.store(), online.shipmentId);
      return history
        ? {
            origin: storedLocation(history.origin),
            destination: storedLocation(history.currentReference),
            custody: {
              originDepot: registeredPointLocation(online.route.originDepot.label, online.route.originDepot),
              destinationDepot: registeredPointLocation(online.route.destinationDepot.label, online.route.destinationDepot),
            },
          }
        : null;
    }

    const registered = [...this.shipments.values()].find((shipment) => shipment.scenario.id === entry.scenario.id);
    if (registered) {
      return {
        origin: registeredLocation(registered.route.origin.label),
        destination: registeredLocation(registered.correction?.toLabel ?? registered.parcel.recipientAddress),
        custody: {
          originDepot: registeredPointLocation(registered.route.originHub.label, registered.route.originHub),
          destinationDepot: registeredPointLocation(registered.route.destinationHub.label, registered.route.destinationHub),
        },
      };
    }

    return null;
  }

  private timelineLocationFor(eventId: string, legIndex: number): string | null {
    const route = this.routeFor(eventId);
    if (!route?.custody) return null;
    if (legIndex <= 2) return route.custody.originDepot.label;
    if (legIndex <= 4) return route.custody.destinationDepot.label;
    return route.destination.label;
  }

  private compactMapLabel(label: string, role: string): string {
    const first = label.split(",")[0]?.trim() || label;
    const place = first === "Multimedia University" ? "MMU" : first;
    return `${place} · ${role}`;
  }

  private mapLocationsFor(eventId: string): MapLocation[] | undefined {
    const entry = this.entries.get(eventId);
    if (!entry) return undefined;
    const route = this.routeFor(eventId);
    if (!route?.origin || !route.custody) return undefined;

    const online = [...this.online.values()].find((run) => run.runId === entry.scenario.id);
    const registered = [...this.shipments.values()].find((shipment) => shipment.scenario.id === entry.scenario.id);
    const senderPoint = online
      ? (() => {
          const history = getShipment(this.store(), online.shipmentId);
          return history ? { latitude: history.origin.latitude, longitude: history.origin.longitude } : null;
        })()
      : registered
        ? { latitude: registered.route.origin.latitude, longitude: registered.route.origin.longitude }
        : null;
    const originDepot = online?.route.originDepot ?? registered?.route.originHub;
    const destinationDepot = online?.route.destinationDepot ?? registered?.route.destinationHub;
    const history = online ? getShipment(this.store(), online.shipmentId) : null;
    const reference = history?.originalReference ?? registered?.parcel.recipientPoint;
    const deliveryPoint = reference ? { latitude: reference.latitude, longitude: reference.longitude } : null;
    const deliveryLabel = history ? storedLocation(history.originalReference).label : registered?.parcel.recipientAddress;

    if (!senderPoint || !originDepot || !destinationDepot || !deliveryPoint) return undefined;
    return [
      {
        id: "sender-reference",
        kind: "sender_reference",
        label: route.origin.label,
        mapLabel: this.compactMapLabel(route.origin.label, "Sender"),
        detail: "Sender reference · context only · no carrier pickup scan.",
        point: senderPoint,
        monitored: false,
      },
      {
        id: "origin-depot",
        kind: "origin_depot",
        label: route.custody.originDepot.label,
        mapLabel: this.compactMapLabel(route.custody.originDepot.label, "Origin depot"),
        detail: "Carrier custody begins.",
        point: originDepot,
        monitored: true,
      },
      {
        id: "destination-depot",
        kind: "destination_depot",
        label: route.custody.destinationDepot.label,
        mapLabel: this.compactMapLabel(route.custody.destinationDepot.label, "Destination depot"),
        detail: "Last-mile dispatch.",
        point: destinationDepot,
        monitored: true,
      },
      {
        id: "delivery",
        kind: "delivery",
        label: deliveryLabel ?? route.destination.label,
        mapLabel: this.compactMapLabel(deliveryLabel ?? route.destination.label, "Delivery reference"),
        detail: "Recorded delivery reference; the reported scan is separate evidence.",
        point: deliveryPoint,
        monitored: true,
      },
    ];
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
      existing.runs.push(ctx);
      if (ctx.ledger?.status !== "noop") existing.current = ctx;
      this.issueConfirmationFor(existing);
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
    this.issueConfirmationFor(entry);
  }

  listQueue(): HandoffSummary[] {
    for (const entry of this.entries.values()) this.reconcileEvidenceReceipt(entry);
    return [...this.entries.values()]
      .filter((entry) => entry.state !== null && isQueueState(entry.state))
      .map((entry) => summaryFrom(entry, this.nowIso))
      .sort((a, b) => b.priority - a.priority || b.ageMinutes - a.ageMinutes);
  }

  listHandoffs(): {
    summary: { automaticallyAccepted: number; total: number; timeframe: string; from: string; to: string };
    items: HandoffSummary[];
  } {
    for (const entry of this.entries.values()) this.reconcileEvidenceReceipt(entry);
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

  /** Rebuild one stored shipment through the same preparation path as ingest. */
  async replayHandoff(
    scenarioId: string,
    legIndex: number,
    options: { onTrace?: (frame: TraceFrame) => void; onProgress?: (message: string) => void } = {},
  ): Promise<AgentContext> {
    const source = [...this.entries.values()].find((entry) => entry.scenario.id === scenarioId);
    if (!source) throw new Error(`No stored shipment has scenario ${scenarioId}.`);
    const { scenario, world } = source;
    const target = scenario.timeline[legIndex];
    if (!target) throw new Error(`Scenario ${scenarioId} has no leg ${legIndex + 1}.`);

    const harness = createHarness(world);
    harness.deps.weather = createOpenMeteoProvider({ cacheDir: OPEN_METEO_CACHE_DIR, network: "cache-only" });
    try {
      seedFleetBackground(harness, world, {
        excludeCourierId: scenario.courier.courierId,
        startMs: START_MS - 8 * 3_600_000,
      });
      upsertScenarioParcels(harness, scenario);
      harness.deps.llm = bootstrapAgentLlm(this.runtimeLlm);
      const args = {
        courierPrivateKey: scenario.courier.keys.privateKey,
        mandateId: scenario.courier.mandate.mandateId,
      };
      options.onProgress?.(`Replaying ${scenario.warmup.length} prior handoffs to build this courier's history`);
      for (const built of scenario.warmup) await ingestWithApproval(harness, built, args);

      if (legIndex > 0) options.onProgress?.(`Replaying legs 1-${legIndex} of this shipment`);
      const disputed = new Set(scenario.disputedEventIds);
      for (const built of scenario.timeline.slice(0, legIndex)) {
        await ingestWithApproval(harness, built, args);
        if (disputed.has(built.event.eventID)) {
          recordDispute(harness, built.event.eventID, epcsOf(built.event)[0] ?? "");
        }
      }

      options.onProgress?.(`Running leg ${legIndex + 1} through the agent`);
      harness.deps.llm = activeAgentLlm(this.runtimeLlm);
      return await ingestEvent(harness, target, { ...args, withCosign: true, onTrace: options.onTrace });
    } finally {
      closeDb(harness.deps.db);
      rmSync(harness.dir, { recursive: true, force: true });
    }
  }

  getHandoff(eventId: string): HandoffDetail | undefined {
    const entry = this.entries.get(eventId);
    if (!entry) return undefined;
    this.reconcileEvidenceReceipt(entry);
    const summary = summaryFrom(entry, this.nowIso);
    const records = entry.harness.deps.ledger.readRecords();
    const abortRecord = [...records]
      .reverse()
      .find((record): record is AbortRecord => record.kind === "abort" && record.eventID === eventId);
    const timeline = [...this.entries.values()]
      .filter((candidate) => candidate.scenario.id === entry.scenario.id)
      .sort((a, b) => a.built.legIndex - b.built.legIndex)
      .map((candidate) => ({
        ...summaryFrom(candidate, this.nowIso),
        locationLabel: this.timelineLocationFor(eventId, candidate.built.legIndex),
      }));
    const authoritativeRunNumber = Math.max(1, entry.runs.findIndex((run) => run === entry.current) + 1);
    const authoritativeRun = runView(entry.current, authoritativeRunNumber, entry.built.event);
    return {
      supportingEvidence: this.publishedEvidence(entry),
      archivedEvidenceCount: this.evidenceStore().list(eventId).length - this.evidenceStore().list(eventId, this.workflowId(entry.harness)).length,
      canApprove: this.canApproveEntry(entry),
      approvalAuditPending: Boolean(entry.pendingApprovalAudit),
      summary,
      route: this.routeFor(eventId),
      event: entry.built.event,
      checks: checksFrom(entry.current),
      flags: flagsFrom(entry.current),
      abortEvidence: abortRecord
        ? {
            code: abortRecord.code,
            ruleId: "H4",
            eventId: abortRecord.eventID,
            boundPayloadHash: abortRecord.boundPayloadHash,
            submittedPayloadHash: abortRecord.payloadHash,
          }
        : null,
      gate: {
        decision: entry.current.gateResult?.decision ?? entry.current.decision ?? null,
        matrixCell: entry.current.gateResult?.matrixCell ?? null,
        rationale: entry.current.gateResult?.rationale ?? null,
        cosignReasons: entry.current.gateResult?.cosignReasons ?? [],
      },
      cosignPolicyEvidence: (entry.current.mandate?.value?.requiresCosignIf ?? []).map(
        (condition) => {
          switch (condition.kind) {
            case "parcel_value_over_sen":
              return {
                kind: condition.kind,
                actual: entry.current.parcel?.declaredValueSen ?? null,
                threshold: condition.value,
              };
            case "recipient_address_not_in_scope":
              return {
                kind: condition.kind,
                actual: entry.current.parcel?.recipientAddress ?? null,
                threshold: null,
              };
            case "inconsistency_score_at_least":
              return {
                kind: condition.kind,
                actual: entry.current.engineResult?.score ?? entry.current.inconsistency?.score ?? null,
                threshold: condition.value,
              };
            case "pattern_score_at_least":
              return {
                kind: condition.kind,
                actual: entry.current.patternOutcome?.score ?? entry.current.pattern?.score ?? null,
                threshold: condition.value,
              };
          }
        },
      ),
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
      locationEvidence: (() => {
        // Online shipments only: a location nobody registered sites for. Said at
        // the location, with the scan's provenance, so the evaluable-check count
        // beside the verdict has its reason next to it.
        const run = this.onlineRunFor(eventId);
        if (!run) return null;
        const reference = getShipment(this.store(), run.shipmentId)?.originalReference;
        return {
          gap: UNREGISTERED_LOCATION_GAP,
          scanSource: "simulation" as const,
          boundary: {
            version: reference?.boundaryVersion ?? "unknown",
            placeholder: reference?.boundaryVersion.startsWith("placeholder-") ?? false,
            // The attribution of the boundary IN FORCE NOW, beside the version this
            // point was actually checked against — which may be an earlier one.
            attribution: this.boundaryNote().label,
          },
        };
      })(),
      addressCorrection: (() => {
        const run = this.onlineRunFor(eventId);
        if (run) {
          if (run.deliveryEventId !== eventId) return null;
          const history = getShipment(this.store(), run.shipmentId);
          const last = history?.corrections.at(-1);
          return history && last
            ? {
                fromLabel: addressLabelOf(history.originalReference),
                toLabel: addressLabelOf(last.to),
                correctedAt: last.correctedAt,
              }
            : null;
        }
        const correction = this.correctionFor(eventId);
        return correction
          ? {
              fromLabel: correction.fromLabel,
              toLabel: correction.toLabel,
              correctedAt: correction.correctedAt,
            }
          : null;
      })(),
      authoritativeRun,
      ledger: {
        sequence: entry.current.ledger?.status === "recorded" ? entry.current.ledger.seq : null,
        chainValid: entry.harness.deps.ledger.verifyChain().valid,
        entries: records.length,
      },
      runs: entry.runs.map((ctx, index) => runView(ctx, index + 1, entry.built.event)),
      actions: [...entry.actions],
      timeline,
      map: buildShipmentMapModel(entry.scenario, entry.world, {
        locations: this.mapLocationsFor(eventId),
        ...(entry.built.leg === "delivery" ? {
          deliveryEvent: entry.built.event,
          deliveryFlags: flagsFrom(entry.current).map((flag) => flag.id),
        } : {}),
      }),
      planConsidered: considerTools(entry.current),
      plan: {
        selectedTools: entry.current.plan?.tools ?? [],
        rationale: entry.current.plan?.rationale ?? null,
        source: entry.current.plan
          ? entry.current.planFromHeuristic
            ? "heuristic"
            : "model"
          : "unavailable",
        rejection: entry.current.planRejection ?? null,
        modelId: entry.current.planModelName?.slice(entry.current.planModelName.indexOf(":") + 1) ?? entry.current.modelRuntime?.modelId ?? null,
        failoverReason: entry.current.planFailoverReason,
        runtimeReason: entry.current.modelRuntime?.reason ?? null,
      },
      externalContext: entry.current.externalContext ?? null,
      toolResults: entry.current.toolResults ?? [],
      reroute: entry.current.reroute ?? null,
      explanation: {
        text: entry.current.explanation ?? null,
        source: entry.current.explanation
          ? entry.current.explanationFromFallback
            ? "fallback"
            : "model"
          : "unavailable",
        rejection: entry.current.explanationRejection ?? null,
        modelId: entry.current.explanationModelName?.slice(entry.current.explanationModelName.indexOf(":") + 1) ?? entry.current.modelRuntime?.modelId ?? null,
        failoverReason: entry.current.explanationFailoverReason,
        runtimeReason: entry.current.modelRuntime?.reason ?? null,
        citations: entry.current.explanationCitations ?? [],
      },
      verdictHash: entry.current.verdict ? canonicalHash(entry.current.verdict) : null,
    };
  }

  private canApproveEntry(entry: StoredEntry): boolean {
    if (entry.pendingApprovalAudit) return true;
    return (entry.state === "awaiting_cosignature" || entry.state === "evidence_submitted")
      && entry.current.halted?.reason === "PENDING_COSIGNATURE"
      && entry.current.gateResult?.decision !== "freeze"
      && !entry.current.engineResult?.aborted
      && Boolean(entry.current.credential?.validSignatures.includes("courier"));
  }

  /** A durable receipt is enough to repair its case projection after a failed write. */
  private reconcileEvidenceReceipt(entry: StoredEntry): void {
    if (entry.state !== "awaiting_evidence" || this.reviewing.has(entry.built.event.eventID)) return;
    const receipt = this.publishedEvidence(entry).at(-1)?.submission;
    if (!receipt) return;
    const priority = priorityFor("evidence_submitted", entry.current.decision);
    const updated = entry.harness.deps.db.update(handoffCases)
      .set({ state: "evidence_submitted", priority, updatedAt: receipt.submittedAt })
      .where(eq(handoffCases.caseId, entry.caseId!)).run();
    if (!updated.changes) throw new Error("The saved evidence receipt cannot yet be projected into its case. Refresh to retry.");
    entry.state = "evidence_submitted";
    entry.priority = priority;
  }

  async submitEvidence(requestId: string, reply: EvidenceReply): Promise<CourierWorkspaceView> {
    const store = this.evidenceStore();
    const request = store.get(requestId);
    if (this.reviewing.has(request.eventId)) throw new Error("Operator review is in progress; refresh before submitting evidence.");
    if (request.courierId !== reply.courierId) throw new Error("Only the assigned courier may submit this evidence.");
    const entry = this.entries.get(request.eventId);
    if (!entry) throw new Error("This workflow belonged to an earlier process. The stored evidence cannot restart it.");
    if (request.workflowId !== this.workflowId(entry.harness)) throw new Error("This evidence request belongs to an earlier workflow instance; it cannot be applied to this run.");
    if (!entry.state || entry.state.startsWith("resolved_")) throw new Error("This case is closed or resolved; no evidence can be submitted.");
    if (canonicalHash(entry.built.event) !== request.payloadHash) throw new Error("The original event no longer matches this evidence request.");
    const rounds = this.publishedEvidence(entry);
    if (rounds.at(-1)?.requestId !== requestId) throw new Error("A newer evidence request exists; respond to the current request.");
    if (entry.state !== "awaiting_evidence" && entry.state !== "evidence_submitted") throw new Error("This case is not awaiting evidence.");
    store.submit(requestId, reply, this.nowIso);
    // The receipt can outlive a failed case write; identical retries repair it.
    const updated = entry.harness.deps.db.update(handoffCases).set({ state: "evidence_submitted", priority: priorityFor("evidence_submitted", entry.current.decision), updatedAt: this.nowIso })
      .where(eq(handoffCases.caseId, entry.caseId!)).run();
    if (!updated.changes) throw new Error("The evidence receipt was saved, but its case projection is unavailable. Retry the same submission.");
    entry.state = "evidence_submitted";
    entry.priority = priorityFor(entry.state, entry.current.decision);
    return this.courierWorkspace(reply.courierId);
  }

  evidenceAttachment(attachmentId: string, actor: { courierId?: string; role?: "operator" }) {
    const file = this.evidenceStore().attachment(attachmentId);
    if (actor.role !== "operator" && actor.courierId !== file.request.courierId) throw new Error("Only the assigned courier or reviewing operator may read this attachment.");
    return file;
  }

  async resolveHandoff(eventId: string, rawRequest: ActionRequest): Promise<HandoffDetail> {
    if (this.reviewing.has(eventId)) throw new Error("An operator action is already in progress for this handoff.");
    this.reviewing.add(eventId);
    try {
      return await this.performOperatorAction(eventId, rawRequest);
    } finally { this.reviewing.delete(eventId); }
  }

  private async performOperatorAction(eventId: string, rawRequest: ActionRequest): Promise<HandoffDetail> {
    let request = OperatorActionRequest.parse(rawRequest);
    const entry = this.entries.get(eventId);
    if (!entry || !entry.state || !entry.caseId) throw new Error("handoff is not actionable");

    if (entry.pendingApprovalAudit && request.action === "approve" && request.note === undefined) {
      request = entry.pendingApprovalAudit;
    }
    const fromState = entry.state;
    const toState = transitionCase(fromState, request.action);
    if (entry.pendingApprovalAudit && (request.action !== "approve" || request.note !== entry.pendingApprovalAudit.note)) {
      throw new Error("The approval was sealed but its audit write is incomplete. Retry the same approval before another action.");
    }
    const intent = this.unpublishedEvidenceIntent(entry);
    if (intent && (request.action !== "request_evidence" || request.note?.trim() !== intent.note)) {
      throw new Error("An earlier evidence request still needs its audit write. Retry the same request note before another action.");
    }

    let evidenceRequest: EvidenceRequestView | undefined;
    if (request.action === "request_evidence") {
      if (!request.note?.trim()) throw new Error("Describe the evidence being requested in an operator note.");
      evidenceRequest = intent ?? this.evidenceStore().request({ eventId, courierId: entry.scenario.courier.courierId, operatorId: OPERATOR_ID,
        workflowId: this.workflowId(entry.harness),
        note: request.note, requestedAt: this.nowIso, payloadHash: canonicalHash(entry.built.event) });
    }

    if (request.action === "approve" && !entry.pendingApprovalAudit) {
      if (!this.canApproveEntry(entry)) throw new Error("Cannot approve this case: a complete eligible pending credential is required; evidence cannot override a hard stop.");
      const approved = await ingestEvent(entry.harness, entry.built, {
        courierPrivateKey: entry.scenario.courier.keys.privateKey,
        mandateId: entry.scenario.courier.mandate.mandateId,
        withCosign: true,
      });
      if (approved.halted || !approved.verdict) throw new Error("completed credential did not seal");
      entry.current = approved;
      entry.runs.push(approved);
      entry.reason = approved.gateResult?.rationale ?? "Approved with an operator co-signature.";
      entry.pendingApprovalAudit = request;
    }

    if (request.action === "propose_reroute" && entry.current.reroute?.status !== "proposed") {
      throw new Error("no authorised reroute exists for this handoff");
    }

    const sequence = this.actionSequence + 1;
    const createdAt = new Date(Date.parse(this.nowIso) + sequence * 1_000).toISOString();
    const action: ActionView = {
      action: request.action,
      note: request.note ?? null,
      operatorId: OPERATOR_ID,
      fromState,
      toState,
      createdAt,
    };
    const priority = priorityFor(toState, entry.current.decision);

    entry.harness.deps.db.transaction((tx) => {
      tx.insert(operatorActions)
        .values({
          actionId: evidenceRequest ? `${entry.caseId}-evidence-${evidenceRequest.requestId}` : `${entry.caseId}-${String(sequence).padStart(3, "0")}`,
          caseId: entry.caseId!,
          ...action,
        })
        .run();
      tx.update(handoffCases)
        .set({
          state: toState,
          priority,
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

    this.actionSequence = sequence;
    entry.actions.push(action);
    entry.state = toState;
    entry.priority = priority;
    entry.pendingApprovalAudit = undefined;
    this.issueConfirmationFor(entry);
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

  /** The fixed demo-world clock used by every generated and user-created handoff. */
  clockProvenance(): { anchorIso: string } {
    return { anchorIso: this.nowIso };
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
    if (this.onlineStore) closeDb(this.onlineStore);
    for (const harness of this.harnesses) {
      closeDb(harness.deps.db);
      rmSync(harness.dir, { recursive: true, force: true });
    }
  }
}

export async function createWorkbench(
  options: { scenarioIds?: ScenarioId[]; courierDrafts?: boolean; runtimeLlm?: RuntimeLlm } = {},
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
  const runtimeLlm = options.runtimeLlm ?? resolveRuntimeLlm();

  const groups: StoredEntry[][] = [];
  const drafts: StoredDraft[] = [];
  for (const id of ids) {
    const built = await buildScenarioEntries(id, {
      holdBackFinalLeg: wantDrafts && id in DRAFT_TITLES,
      llm: bootstrapAgentLlm(runtimeLlm),
    });
    groups.push(built.entries);
    if (built.draft) drafts.push(built.draft);
  }

  return new OperatorWorkbench(groups.flat(), drafts, runtimeLlm);
}

declare global {
  var __vigilOperatorWorkbench: Promise<OperatorWorkbench> | undefined;
}

/** Process-long state: Next route modules share this rather than regenerating per request. */
export function getWorkbench(): Promise<OperatorWorkbench> {
  globalThis.__vigilOperatorWorkbench ??= createWorkbench();
  return globalThis.__vigilOperatorWorkbench;
}

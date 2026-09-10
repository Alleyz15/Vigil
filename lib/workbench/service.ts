import { eq } from "drizzle-orm";
import { closeDb, type VigilDb } from "@/lib/db/client";
import { handoffCases, operatorActions, parcels } from "@/lib/db/schema";
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
import {
  flagsFrom,
  runView,
  summaryFrom,
  type ActionView,
  type HandoffDetail,
  type HandoffSummary,
  type WorkbenchEntry,
} from "./read-model";

const SEED = "vigil-2026";
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

async function buildScenarioEntries(id: ScenarioId): Promise<StoredEntry[]> {
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

  const entries: StoredEntry[] = [];
  for (const built of scenario.timeline) {
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

  return entries;
}

export class OperatorWorkbench {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly harnesses = new Set<IngestHarness>();
  private actionSequence = 0;
  private readonly nowIso: string;

  constructor(entries: StoredEntry[]) {
    for (const entry of entries) {
      this.entries.set(entry.built.event.eventID, entry);
      this.harnesses.add(entry.harness);
    }
    const latest = Math.max(...entries.map((entry) => Date.parse(entry.createdAt)));
    this.nowIso = new Date(latest + 12 * 60_000).toISOString();
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

export async function createWorkbench(options: { scenarioIds?: ScenarioId[] } = {}): Promise<OperatorWorkbench> {
  const ids = options.scenarioIds ?? SCENARIO_IDS;
  const groups: StoredEntry[][] = [];
  for (const id of ids) groups.push(await buildScenarioEntries(id));
  return new OperatorWorkbench(groups.flat());
}

declare global {
  var __vigilOperatorWorkbench: Promise<OperatorWorkbench> | undefined;
}

/** Process-long state: Next route modules share this rather than regenerating per request. */
export function getWorkbench(): Promise<OperatorWorkbench> {
  globalThis.__vigilOperatorWorkbench ??= createWorkbench();
  return globalThis.__vigilOperatorWorkbench;
}

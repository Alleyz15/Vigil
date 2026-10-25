import type { CourierDraft, CourierQueueItem, RoleIdentity } from "@/lib/workbench/service";
import type { AxisValue, HandoffDetail, HandoffState, HandoffSummary } from "@/lib/workbench/read-model";
import { courierOutcome } from "@/lib/workbench/courier";

/**
 * The split-screen co-sign model.
 *
 * ONE handoff, TWO people, TWO keys, and a credential neither of them can
 * assemble alone. The claim this view exists to make legible is rule 3: a
 * high-risk handoff requires a token co-signed by the courier's key AND the
 * operator's key, and the courier's half alone does not merely lack approval —
 * it FAILS VERIFICATION.
 *
 * Both panes read the same live workbench state. Nothing here is a fixture: the
 * courier pane shows what the courier's own submission returned, and the
 * operator pane shows what the gate computed from it. They cannot disagree,
 * because there is one source.
 *
 * WHY THIS IS A PURE FUNCTION. The phase transitions and the statement of what
 * the two halves add up to are the things worth testing. A component computing
 * that inline would be untestable and would drift from the credential it
 * describes (rule 3g).
 */

export type CosignChoice = {
  handoffId: string;
  eventId: string;
  source: "seeded" | "registered" | "online";
  scenarioId: string;
  waybillNo: string;
  title: string;
  eventTime: string;
  state: HandoffState | "prepared";
  queueItem: CourierQueueItem | null;
  draft: CourierDraft | null;
};

export type CosignSubject = {
  handoffId: string;
  scenarioId: string;
  source: CosignChoice["source"];
  title: string;
  epc: string;
  waybillNo: string;
  leg: string;
  eventTime: string;
  eventId: string;
  attempts: CourierDraft["attempts"];
  operatorSeal: CourierDraft["operatorSeal"];
};

function sourceOfScenario(scenarioId: string): CosignChoice["source"] {
  if (scenarioId.startsWith("B-O-")) return "online";
  if (scenarioId.startsWith("B-")) return "registered";
  return "seeded";
}

export function buildCosignChoices(
  queueItems: CourierQueueItem[],
  handoffs: HandoffSummary[],
  drafts: CourierDraft[] = [],
): CosignChoice[] {
  const summariesByEvent = new Map(handoffs.map((summary) => [summary.eventId, summary]));
  const choices: CosignChoice[] = queueItems.map((item) => ({
    handoffId: item.handoffId,
    eventId: item.eventId,
    source: item.source,
    scenarioId: item.scenarioId,
    waybillNo: item.waybillNo,
    title: item.title,
    eventTime: item.eventTime,
    state:
      item.state ??
      summariesByEvent.get(item.eventId)?.state ??
      (item.attempts.length === 0 ? "prepared" : "accepted"),
    queueItem: item,
    draft: null,
  }));
  const queuedEvents = new Set(choices.map((choice) => choice.eventId));
  const representedSeededScenarios = new Set(
    choices.filter((choice) => choice.source === "seeded").map((choice) => choice.scenarioId),
  );

  // `/courier` is intentionally scoped to one courier identity, so it may omit
  // prepared drafts belonging to other seeded scenarios. This presentation
  // selector is cross-scenario: merge those drafts here without weakening the
  // production courier workspace's identity boundary.
  for (const draft of drafts) {
    if (queuedEvents.has(draft.eventId) || representedSeededScenarios.has(draft.scenarioId)) continue;
    choices.push({
      handoffId: `seeded:${draft.draftId}`,
      eventId: draft.eventId,
      source: "seeded",
      scenarioId: draft.scenarioId,
      waybillNo: draft.waybillNo,
      title: draft.title,
      eventTime: draft.eventTime,
      state: draft.attempts.length === 0 ? "prepared" : "accepted",
      queueItem: null,
      draft,
    });
    queuedEvents.add(draft.eventId);
    representedSeededScenarios.add(draft.scenarioId);
  }

  // S2 contains many deliveries by design. The demo rail names scenarios, so
  // seeded history contributes one newest representative delivery per S0-S6,
  // while sender-created shipments remain individually selectable.
  const newestFirst = [...handoffs].sort((a, b) => Date.parse(b.eventTime) - Date.parse(a.eventTime));
  for (const summary of newestFirst) {
    if (summary.bizStep !== "delivering" || queuedEvents.has(summary.eventId)) continue;
    const source = sourceOfScenario(summary.scenarioId);
    if (source === "seeded" && representedSeededScenarios.has(summary.scenarioId)) continue;
    choices.push({
      handoffId: `history:${summary.eventId}`,
      eventId: summary.eventId,
      source,
      scenarioId: summary.scenarioId,
      waybillNo: summary.parcel.waybillNo,
      title: `Delivery handoff — ${summary.scenarioId}`,
      eventTime: summary.eventTime,
      state: summary.state,
      queueItem: null,
      draft: null,
    });
    queuedEvents.add(summary.eventId);
    if (source === "seeded") representedSeededScenarios.add(summary.scenarioId);
  }

  const sourceOrder = { online: 0, registered: 1, seeded: 2 } as const;
  return choices.sort((a, b) => {
    const sourceDifference = sourceOrder[a.source] - sourceOrder[b.source];
    if (sourceDifference !== 0) return sourceDifference;
    if (a.source === "seeded" && b.source === "seeded") {
      const scenarioDifference = Number(a.scenarioId.slice(1)) - Number(b.scenarioId.slice(1));
      if (Number.isFinite(scenarioDifference) && scenarioDifference !== 0) return scenarioDifference;
      return a.scenarioId.localeCompare(b.scenarioId);
    }
    return Date.parse(b.eventTime) - Date.parse(a.eventTime);
  });
}

export function selectCosignChoice(
  choices: CosignChoice[],
  requestedHandoffId?: string,
): CosignChoice | undefined {
  return choices.find((choice) => choice.handoffId === requestedHandoffId) ?? choices[0];
}

export function cosignSubjectFromQueue(item: CourierQueueItem): CosignSubject {
  return {
    handoffId: item.handoffId,
    scenarioId: item.scenarioId,
    source: item.source,
    title: item.title,
    epc: item.epc,
    waybillNo: item.waybillNo,
    leg: item.leg,
    eventTime: item.eventTime,
    eventId: item.eventId,
    attempts: item.attempts,
    operatorSeal: item.operatorSeal,
  };
}

export function cosignSubjectFromDraft(draft: CourierDraft): CosignSubject {
  return {
    handoffId: `seeded:${draft.draftId}`,
    scenarioId: draft.scenarioId,
    source: "seeded",
    title: draft.title,
    epc: draft.epc,
    waybillNo: draft.waybillNo,
    leg: draft.leg,
    eventTime: draft.eventTime,
    eventId: draft.eventId,
    attempts: draft.attempts,
    operatorSeal: draft.operatorSeal,
  };
}

export function cosignSubjectFromDetail(detail: HandoffDetail): CosignSubject {
  return {
    handoffId: `history:${detail.summary.eventId}`,
    scenarioId: detail.summary.scenarioId,
    source: sourceOfScenario(detail.summary.scenarioId),
    title: `Delivery handoff — ${detail.summary.scenarioId}`,
    epc: detail.summary.parcel.epc,
    waybillNo: detail.summary.parcel.waybillNo,
    leg: detail.summary.bizStep,
    eventTime: detail.summary.eventTime,
    eventId: detail.summary.eventId,
    attempts: [],
    operatorSeal: null,
  };
}

export type CosignPhase =
  /** The courier holds a draft. Nothing signed, nothing submitted, nothing queued. */
  | "unsubmitted"
  /** Submitted and courier-signed. The gate wants an operator and there is not one. */
  | "awaiting_cosignature"
  /** Both signatures present. The credential verifies and the ledger has an entry. */
  | "sealed"
  /**
   * Submitted, and the outcome is none of the three above — a freeze on an
   * invalid signature, say. Kept as its own phase rather than folded into
   * `awaiting_cosignature`, because "the operator has not signed yet" and
   * "this handoff was decided without one" are different situations, and a
   * viewer must not be shown the first when the second happened.
   */
  | "decided_without_cosignature";

export type CosignModel = {
  phase: CosignPhase;
  /** The fact both panes share, and the reason this is one handoff and not two. */
  shared: {
    source: CosignChoice["source"];
    eventId: string;
    waybillNo: string;
    epc: string;
    leg: string;
    eventTime: string;
    scenarioId: string;
    /** Present only once something has been submitted and hashed. */
    eventHash: string | null;
  };
  courier: {
    identity: RoleIdentity;
    /** How many times this draft has been put through the agent. */
    attempts: number;
    signed: boolean;
    headline: string;
    detail: string;
    /** Verbatim verifier output, never our paraphrase of it. */
    problems: string[];
    handoffId: string;
  };
  operator: {
    identity: RoleIdentity;
    /** False until the courier submits: an empty queue is the honest state, not a blank panel. */
    queued: boolean;
    inconsistency: AxisValue | null;
    pattern: AxisValue | null;
    coverageLine: string | null;
    flags: HandoffDetail["flags"];
    gate: HandoffDetail["gate"] | null;
    canCosign: boolean;
  };
  credential: HandoffDetail["credential"];
  ledger: { sealed: boolean; sequence: number | null; entries: number; chainValid: boolean } | null;
  /** What the two halves currently add up to. Derived, never chosen per phase. */
  arithmetic: { headline: string; detail: string };
};

export function buildCosignModel(input: {
  draft?: CourierDraft;
  subject?: CosignSubject;
  detail: HandoffDetail | undefined;
  identities: { courier: RoleIdentity; operator: RoleIdentity };
}): CosignModel {
  const { detail, identities } = input;
  const draft = input.subject ?? (input.draft ? {
    ...input.draft,
    handoffId: `seeded:${input.draft.draftId}`,
    source: "seeded" as const,
  } : undefined);
  if (!draft) throw new Error("A co-sign handoff subject is required.");

  const attempt = draft.attempts.at(-1);

  /**
   * The authoritative run on this handoff, which is not always the courier's own.
   *
   * The co-signed resubmission is a run on the promoted entry, not a draft
   * attempt, so reading `draft.attempts` alone leaves the courier's card saying
   * "signature valid, but insufficient" while the bar beneath it says the
   * credential verifies and the ledger has sealed. Both sentences were true
   * when written and the pair is a contradiction on a paused frame.
   *
   * The courier's card answers "where is my handoff now", so it follows the
   * authoritative run. A later failed retry stays historical. How many times
   * THEY submitted still comes from the draft.
   */
  const latest = detail?.authoritativeRun ?? detail?.runs.at(-1) ?? attempt?.run;
  const outcome = latest ? courierOutcome(latest) : null;
  const credential = detail?.credential ?? latest?.credential ?? null;
  const sealed = detail?.ledger.sequence !== null && detail?.ledger.sequence !== undefined;

  const phase: CosignPhase = !latest
    ? "unsubmitted"
    : sealed
      ? "sealed"
      : credential?.cosignRequired && credential.courierValid && !credential.operatorValid
        ? "awaiting_cosignature"
        : "decided_without_cosignature";

  return {
    phase,
    shared: {
      source: draft.source,
      eventId: draft.eventId,
      waybillNo: draft.waybillNo,
      epc: draft.epc,
      leg: draft.leg,
      eventTime: draft.eventTime,
      scenarioId: draft.scenarioId,
      eventHash: latest?.eventHash ?? null,
    },
    courier: {
      identity: identities.courier,
      attempts: draft.attempts.length,
      signed: credential?.courierValid ?? false,
      headline: outcome?.headline ?? "Ready to sign and submit",
      detail:
        outcome?.detail ??
        "Nothing has been sent yet. Submitting signs this scan with the device key held on this handset.",
      problems: outcome?.problems ?? [],
      handoffId: draft.handoffId,
    },
    operator: {
      identity: identities.operator,
      queued: Boolean(detail),
      inconsistency: detail?.summary.inconsistency ?? null,
      pattern: detail?.summary.pattern ?? null,
      coverageLine: detail?.summary.coverageLine ?? null,
      flags: detail?.flags ?? [],
      gate: detail?.gate ?? null,
      canCosign: detail?.canApprove !== undefined
        ? detail.canApprove
        : detail?.summary.state === "awaiting_cosignature",
    },
    credential,
    ledger: detail
      ? {
          sealed,
          sequence: detail.ledger.sequence,
          entries: detail.ledger.entries,
          chainValid: detail.ledger.chainValid,
        }
      : null,
    arithmetic: arithmeticOf(credential),
  };
}

/**
 * The sentence under the two panes, computed from the credential rather than
 * chosen by phase.
 *
 * Rule 3g: text that restates a decision must be derived FROM the decision. The
 * tempting shortcut is a switch on `phase` with a string per case, which reads
 * identically today and silently keeps saying "courier signature valid" after
 * the verifier stops agreeing. The booleans below come from
 * `verifyCredential()`, so this line cannot drift from what was actually
 * checked.
 */
function arithmeticOf(credential: CosignModel["credential"]): {
  headline: string;
  detail: string;
} {
  if (!credential) {
    return {
      headline: "No credential exists yet",
      detail: "Nothing is signed, so there is nothing to verify and nothing to co-sign.",
    };
  }

  if (credential.valid) {
    if (!credential.cosignRequired) {
      return {
        headline: "Courier signature = a credential that verifies",
        detail:
          "The courier signed the event; an operator signature was not required by this handoff's mandate.",
      };
    }
    return {
      headline: "Courier signature + operator signature = a credential that verifies",
      detail:
        "Both halves over the same bytes. The identical event ran the identical pipeline again, and this time it could seal.",
    };
  }

  const half = credential.courierValid ? "valid" : "missing or unverifiable";

  if (credential.cosignRequired && credential.courierValid) {
    return {
      headline: "Courier signature valid + no operator signature = not a credential",
      detail:
        "The signature is cryptographically sound and nothing was sealed. Approval is not a flag somebody forgot to tick.",
    };
  }

  return {
    headline: `Courier signature ${half} — the credential does not verify`,
    detail: "The verifier's own words are listed on the courier's side.",
  };
}

/** Phase order, for the progress rail. Exported so the view cannot invent a different sequence. */
export const COSIGN_STEPS: { phase: CosignPhase; label: string }[] = [
  { phase: "unsubmitted", label: "Courier holds the scan" },
  { phase: "awaiting_cosignature", label: "Signed, submitted, not enough" },
  { phase: "sealed", label: "Co-signed and sealed" },
];

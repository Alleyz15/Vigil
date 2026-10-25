"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, CircleDashed, RotateCcw, RefreshCw, MapPin, Package, PenLine, Shield } from "lucide-react";
import { courierOutcome, type CourierOutcome, type CourierOutcomeKind } from "@/lib/workbench/courier";
import type { CourierQueueItem, CourierWorkspaceView } from "@/lib/workbench/service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import { CourierShell, type CourierMode } from "@/components/shells/courier-shell";
import { EvidenceWorkspace, type EvidenceDraft } from "./evidence-workspace";
import { RouteSummary } from "@/components/shipment/route-summary";
import { cn } from "@/lib/utils";

/**
 * The courier surface.
 *
 * DELIBERATELY THIN. This is not a courier product and must not grow into one:
 * it exists so the cryptographic fact is legible across two screens, and so a
 * viewer can see that "approval" is a second signature rather than a flag
 * somebody ticked. Anti-reference 3 also applies — nothing here ranks the
 * courier, scores them, or shows them anyone else's work.
 */

const TONE: Record<CourierOutcomeKind, { ring: string; text: string; Icon: typeof CheckCircle2 }> = {
  sealed: { ring: "border-emerald-500/40 bg-emerald-500/5", text: "text-emerald-700 dark:text-emerald-400", Icon: CheckCircle2 },
  replay_noop: { ring: "border-emerald-500/30 bg-emerald-500/5", text: "text-emerald-700 dark:text-emerald-400", Icon: RotateCcw },
  signature_insufficient: { ring: "border-blue-500/40 bg-blue-500/5", text: "text-blue-700 dark:text-blue-400", Icon: CircleDashed },
  signature_missing: { ring: "border-blue-500/30 bg-blue-500/5", text: "text-blue-700 dark:text-blue-400", Icon: CircleDashed },
  signature_invalid: { ring: "border-red-500/40 bg-red-500/5", text: "text-red-700 dark:text-red-400", Icon: CircleAlert },
  replay_reused_id: { ring: "border-red-500/40 bg-red-500/5", text: "text-red-700 dark:text-red-400", Icon: CircleAlert },
  undecided: { ring: "border-muted bg-muted/30", text: "text-muted-foreground", Icon: CircleDashed },
};

type Attempt = CourierQueueItem["attempts"][number];

export function CourierView({ initial }: { initial: CourierWorkspaceView }) {
  const [workspace, setWorkspace] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actorId, setActorId] = useState(initial.identity.subject);
  const [actorReady, setActorReady] = useState(true);
  const ready = useRef(true);
  const [mode, setMode] = useState<CourierMode>("handoffs");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, EvidenceDraft>>({});
  const [selectedId, setSelectedId] = useState(initial.items[0]?.handoffId ?? null);
  const selected = workspace.items.find((item) => item.handoffId === selectedId) ?? workspace.items[0];
  const evidenceItems = workspace.evidenceRequests ?? [];
  const selectedEvidence = evidenceItems.find((item) => item.request.requestId === requestId) ?? evidenceItems[0];
  const draftKey = `${actorId}:${selectedEvidence?.request.requestId ?? ""}`;
  const identity = mode === "evidence" ? selectedEvidence?.identity ?? workspace.identity : selected?.identity ?? workspace.identity;
  const readVersion = useRef(0);
  const submitting = useRef(false);

  const adoptWorkspace = useCallback((next: CourierWorkspaceView) => {
    setWorkspace(next);
    setActorId(next.identity.subject);
    setSelectedId((current) =>
      current && next.items.some((item) => item.handoffId === current)
        ? current
        : (next.items[0]?.handoffId ?? null),
    );
    setRequestId((current) => current && next.evidenceRequests?.some((item) => item.request.requestId === current)
      ? current : next.evidenceRequests?.[0]?.request.requestId ?? null);
  }, []);

  const loadWorkspace = useCallback(async (courierId?: string, switchIdentity = false) => {
    if (submitting.current) return;
    if (switchIdentity && courierId !== undefined) {
      setActorId(courierId);
      ready.current = false;
      setActorReady(false);
    }
    const version = ++readVersion.current;
    setLoading(true);
    setError(null);
    try {
      const listing = await fetch(`/api/courier/handoffs${courierId !== undefined ? `?courierId=${encodeURIComponent(courierId)}` : ""}`, { cache: "no-store" });
      const next = await listing.json() as CourierWorkspaceView & { error?: string };
      if (!listing.ok) throw new Error(next.error ?? "Could not load the courier handoff queue.");
      if (!next.identity || !Array.isArray(next.items) || (courierId !== undefined && next.identity.subject !== courierId)) {
        throw new Error("The queue response did not match the requested courier.");
      }
      // A newer identity/read or a mutation owns the workspace now.
      if (version !== readVersion.current) return;
      adoptWorkspace(next);
      ready.current = true;
      setActorReady(true);
    } catch (caught) {
      if (version === readVersion.current) setError((caught as Error).message);
    } finally {
      if (version === readVersion.current) setLoading(false);
    }
  }, [adoptWorkspace]);

  useEffect(() => {
    const versionCounter = readVersion;
    const queryActor = new URLSearchParams(window.location.search).get("courierId");
    // Sync the page actor before the first fetch so a queued submit cannot use the old actor.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadWorkspace(queryActor ?? undefined, queryActor !== null);
    return () => { versionCounter.current++; };
  }, [loadWorkspace]);

  function switchActor(courierId: string) {
    if (submitting.current) return;
    const url = new URL(window.location.href);
    url.searchParams.set("courierId", courierId);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    void loadWorkspace(courierId, true);
  }

  function beginSubmission(label: string): boolean {
    if (submitting.current || !ready.current) return false;
    submitting.current = true;
    readVersion.current++;
    setLoading(false);
    setBusy(label);
    setError(null);
    return true;
  }

  function updateDraft(patch: Partial<Pick<EvidenceDraft, "explanation" | "files">>) {
    if (submitting.current) return;
    setDrafts((current) => ({ ...current, [draftKey]: {
      ...(current[draftKey] ?? { submissionId: crypto.randomUUID(), explanation: "", files: [] }), ...patch,
    } }));
  }

  async function submitEvidence() {
    const draft = drafts[draftKey];
    if (!selectedEvidence || selectedEvidence.request.courierId !== actorId || !draft?.explanation.trim()
      || selectedEvidence.request.submission || selectedEvidence.state !== "awaiting_evidence") return;
    if (!beginSubmission("evidence")) return;
    const form = new FormData();
    form.set("courierId", actorId);
    form.set("submissionId", draft.submissionId);
    form.set("explanation", draft.explanation);
    for (const file of draft.files) form.append("files", file);
    try {
      const response = await fetch(`/api/courier/evidence/${encodeURIComponent(selectedEvidence.request.requestId)}`, { method: "POST", body: form });
      const payload = await response.json() as { error?: string; workspace?: CourierWorkspaceView };
      if (!response.ok) throw new Error(payload.error ?? "Evidence submission failed.");
      if (!payload.workspace?.identity || !Array.isArray(payload.workspace.items) || payload.workspace.identity.subject !== actorId) {
        throw new Error("The submission response did not include the updated courier queue. Refresh requests before retrying.");
      }
      adoptWorkspace(payload.workspace);
      setDrafts((current) => { const next = { ...current }; delete next[draftKey]; return next; });
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      submitting.current = false;
      setBusy(null);
    }
  }

  async function submit(handoffId: string, signed: boolean) {
    if (!workspace.items.some((item) => item.handoffId === handoffId && item.courierId === actorId)) return;
    if (!beginSubmission(`${handoffId}:${signed}`)) return;
    try {
      const response = await fetch(`/api/courier/handoffs/${encodeURIComponent(handoffId)}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signed, courierId: actorId }),
      });
      const payload = await response.json() as { error?: string; workspace?: CourierWorkspaceView };
      if (!response.ok) throw new Error(payload.error ?? "submission failed");
      if (!payload.workspace?.identity || !Array.isArray(payload.workspace.items) || payload.workspace.identity.subject !== actorId) {
        throw new Error("The submission response did not include the updated courier queue. Submission may have completed; reload before retrying.");
      }
      adoptWorkspace(payload.workspace);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      submitting.current = false;
      setBusy(null);
    }
  }

  return (
    <CourierShell identity={actorReady ? identity : { role: "courier", label: actorId, subject: actorId, keyFingerprint: null, note: "Awaiting courier workspace" }}
      mode={mode} onModeChange={(next) => { if (!submitting.current) setMode(next); }} busy={busy !== null}
      evidenceCount={evidenceItems.filter((item) => item.state === "awaiting_evidence" && !item.request.submission).length}
      identityControls={<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <label htmlFor="demo-courier-identity" className="font-medium">Demo courier identity</label>
        <select id="demo-courier-identity" value={actorId} disabled={busy !== null} onChange={(event) => switchActor(event.target.value)} className="min-h-9 max-w-full rounded-md border bg-background px-2 text-sm">
          {!(workspace.couriers ?? [workspace.identity]).some((courier) => courier.subject === actorId) && <option value={actorId}>{actorId}</option>}
          {(workspace.couriers ?? [workspace.identity]).map((courier) => <option key={courier.subject} value={courier.subject}>{courier.subject} · {courier.label}</option>)}
        </select>
        <span className="text-muted-foreground">Not authentication. Demo identities only.</span>
      </div>}>
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">{mode === "handoffs" ? "Your handoffs" : "Evidence requests"}</h1>
        <Button size="sm" variant="outline" disabled={busy !== null || loading} onClick={() => void loadWorkspace(actorId)}><RefreshCw aria-hidden="true" className="size-4" />{mode === "evidence" ? "Refresh requests" : "Refresh handoffs"}</Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {mode === "handoffs" ? "Choose a prepared delivery scan and sign it with your device key." : "Requests from your operator and your submitted supporting material."}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ProvenanceLabel>Seeded and sender-dispatched synthetic handoffs</ProvenanceLabel>
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      {!actorReady ? <p role="status" className="mt-6 text-sm text-muted-foreground">{loading ? "Loading courier workspace..." : "Courier workspace unavailable. Refresh or choose another demo courier."}</p> : mode === "evidence" ? (
        <EvidenceWorkspace items={evidenceItems} selected={selectedEvidence} onSelect={setRequestId} draft={drafts[draftKey]} onChange={updateDraft} onSubmit={() => void submitEvidence()} busy={busy !== null} />
      ) : <div className="courier-workspace mt-6">
      <section aria-label="Prepared delivery scans" className="min-w-0 overflow-hidden rounded-lg border bg-card">
        <div className="border-b p-5"><h2 className="text-sm font-semibold">Prepared delivery scans <Badge variant="secondary" className="ml-2">{workspace.items.length} handoffs</Badge></h2></div>
      <ul>
        {workspace.items.map((item) => (
          <li key={item.handoffId} className="border-b">
            <button type="button" disabled={busy !== null} aria-pressed={selected?.handoffId === item.handoffId} onClick={() => setSelectedId(item.handoffId)} className={cn("w-full p-5 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary", selected?.handoffId === item.handoffId && "bg-sidebar-accent")}>
              <span className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{item.title}</span><Badge variant="outline" className="text-xs font-normal">{sourceLabel(item.source)}</Badge></span>
              <span className="mt-3 flex items-center gap-2 font-mono text-xs"><Package aria-hidden="true" className="size-4 shrink-0" />{item.waybillNo}</span>
              <span className="mt-2 flex items-start gap-2 text-xs text-muted-foreground"><MapPin aria-hidden="true" className="size-4 shrink-0" />{item.route.destination.label}</span>
              <span className="mt-3 block font-mono text-xs text-muted-foreground">{item.runId} · {item.leg}</span>
              {item.fault && item.fault !== "none" && <span className="mt-2 block text-xs text-amber-700">Demo injection · {item.fault}</span>}
            </button>
          </li>
        ))}
      </ul>
      <p className="flex gap-2 p-5 text-xs leading-5 text-muted-foreground"><Shield aria-hidden="true" className="mt-0.5 size-4 shrink-0" />The courier supplies evidence and a device signature. The verifier owns the decision.</p>
      </section>
      {selected ? <HandoffCard item={selected} busy={busy} onSubmit={(signed) => submit(selected.handoffId, signed)} /> : <p className="p-5 text-sm text-muted-foreground">No prepared delivery scans available.</p>}
      </div>}
    </div>
    </CourierShell>
  );
}

function sourceLabel(source: CourierQueueItem["source"]): string {
  if (source === "registered") return "Sender · registered point";
  if (source === "online") return "Sender · point-to-point";
  return "Seeded scenario";
}

function HandoffCard({
  item,
  busy,
  onSubmit,
}: {
  item: CourierQueueItem;
  busy: string | null;
  onSubmit: (signed: boolean) => void;
}) {
  const latest = item.attempts.at(-1);
  const outcome = item.currentRun ? courierOutcome(item.currentRun) : latest?.outcome;
  const sealed = item.currentRun?.sealed ?? item.attempts.some((attempt: Attempt) => attempt.outcome.sealed);
  const hasSeparateCurrentRun = item.currentRun && item.currentRun.run !== latest?.run.run;

  return (
    <section aria-label="Selected handoff" className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b p-5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{item.title}</h2>
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{item.eventId}</p>
        </div>
        <Badge variant="outline" className="font-mono text-xs font-normal">
          {item.runId} · {item.leg}
        </Badge>
      </div>
      <dl className="grid gap-5 border-b p-5 sm:grid-cols-[minmax(8rem,0.65fr)_minmax(0,2fr)_minmax(8rem,0.85fr)]">
        <div className="min-w-0"><dt className="text-xs text-muted-foreground">Waybill</dt><dd className="mt-2 break-all font-mono text-xs">{item.waybillNo}</dd></div>
        <div className="min-w-0"><dt className="sr-only">Route</dt><dd><RouteSummary route={item.route} /></dd></div>
        <div className="min-w-0"><dt className="text-xs text-muted-foreground">EPCIS leg</dt><dd className="mt-2 text-sm">{item.leg} · {item.runId}</dd></div>
      </dl>
      <div className="p-5"><h3 className="flex items-center gap-2 text-sm font-semibold"><PenLine aria-hidden="true" className="size-4 text-primary" />Courier device signature</h3>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">The credential travels alongside the unchanged EPCIS event, never inside it.</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => onSubmit(true)} disabled={busy !== null}>
          <PenLine aria-hidden="true" className="size-4" />
          {sealed ? "Submit again" : "Sign and submit"}
        </Button>
        {!sealed && item.attempts.length === 0 && (
          <Button size="sm" variant="outline" onClick={() => onSubmit(false)} disabled={busy !== null}>
            Submit without signing
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {sealed
            ? "Submitting again sends the identical scan — nothing about it changes."
            : "Your device signs the scan; the signature travels alongside it, never inside it."}
        </span>
      </div>
      </div>

      {outcome && <OutcomePanel outcome={outcome} />}
      {(item.attempts.length > 1 || item.operatorSeal || (latest && hasSeparateCurrentRun)) && (
        <AttemptHistory attempts={item.attempts} operatorSeal={item.operatorSeal} />
      )}
    </section>
  );
}

function OutcomePanel({ outcome }: { outcome: CourierOutcome }) {
  const tone = TONE[outcome.kind];
  const Icon = tone.Icon;

  return (
    /*
      THE RESULT IS THE MOST IMPORTANT THING ON THIS PAGE, and it used to be the
      quietest: the tone classes name a border colour but nothing set a border
      WIDTH, so the panel rendered as a 5% tint with no edge — an ordinary notice
      under two white cards. It now has a heavy edge and a larger headline, which
      is structure (rule 1k), so no new colour was needed to make it lead.
    */
    <div className={cn("mx-4 mb-4 rounded-md border-2 px-4 py-4", tone.ring)}>
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className={cn("mt-1 size-5 shrink-0", tone.text)} />
        <div className="min-w-0">
          <p className={cn("text-base font-semibold", tone.text)}>{outcome.headline}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{outcome.detail}</p>

          <p className="mt-2 text-xs font-medium">
            {outcome.sealed ? "Recorded in the ledger." : "Nothing was written to the ledger."}
          </p>

          {outcome.problems.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                What the credential check reported
              </div>
              <ul className="mt-2 flex flex-col gap-1">
                {outcome.problems.map((problem) => (
                  <li key={problem} className="font-mono text-xs leading-5 text-muted-foreground">
                    {problem}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Every attempt, kept visible.
 *
 * The sequence IS the argument: valid-but-insufficient, then sealed once an
 * operator signed, then a no-op on a repeat. Showing only the latest state
 * would leave a viewer unable to see that the same scan was submitted twice and
 * treated differently for a reason.
 */
function AttemptHistory({
  attempts,
  operatorSeal,
}: {
  attempts: Attempt[];
  operatorSeal: CourierQueueItem["operatorSeal"];
}) {
  const firstPostSeal = attempts.findIndex((attempt) => attempt.run.ledgerStatus === "noop");
  const beforeSeal = firstPostSeal === -1 ? attempts : attempts.slice(0, firstPostSeal);
  const afterSeal = firstPostSeal === -1 ? [] : attempts.slice(firstPostSeal);

  return (
    <div className="px-4 pb-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Submission history
      </div>
      <ol className="mt-2 flex flex-col gap-2">
        {beforeSeal.map((attempt) => (
          <li key={attempt.run.run} className="flex flex-wrap items-baseline gap-2 text-xs">
            <span className="font-mono text-muted-foreground">#{attempt.run.run}</span>
            <span className={cn("font-medium", TONE[attempt.outcome.kind].text)}>
              {attempt.outcome.headline}
            </span>
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {attempt.run.ledgerStatus ?? "no ledger entry"}
            </span>
          </li>
        ))}
        {operatorSeal && (
          <li className="flex flex-wrap items-baseline gap-2 border-y border-dashed py-2 text-xs">
            <span className="font-medium text-emerald-700 dark:text-emerald-400">Operator co-signed and sealed</span>
            <span className="font-mono text-muted-foreground">{operatorSeal.operatorId}</span>
            <span className="ml-auto font-mono text-xs text-muted-foreground">{operatorSeal.ledgerStatus}</span>
          </li>
        )}
        {afterSeal.map((attempt) => (
          <li key={attempt.run.run} className="flex flex-wrap items-baseline gap-2 text-xs">
            <span className="font-mono text-muted-foreground">#{attempt.run.run}</span>
            <span className={cn("font-medium", TONE[attempt.outcome.kind].text)}>
              {attempt.outcome.headline}
            </span>
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {attempt.run.ledgerStatus ?? "no ledger entry"}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

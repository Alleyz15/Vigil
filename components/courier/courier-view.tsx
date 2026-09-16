"use client";

import { useState } from "react";
import { CheckCircle2, CircleAlert, CircleDashed, RotateCcw, MapPin, Package, PenLine, Shield } from "lucide-react";
import type { CourierOutcome, CourierOutcomeKind } from "@/lib/workbench/courier";
import type { CourierDraft } from "@/lib/workbench/service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
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

type Attempt = CourierDraft["attempts"][number];

export function CourierView({ initial }: { initial: CourierDraft[] }) {
  const [drafts, setDrafts] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(initial[0]?.draftId ?? null);
  const selected = drafts.find((draft) => draft.draftId === selectedId) ?? drafts[0];

  async function submit(draftId: string, signed: boolean) {
    setBusy(`${draftId}:${signed}`);
    setError(null);
    try {
      const response = await fetch(`/api/courier/drafts/${draftId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signed }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "submission failed");

      const listing = await fetch("/api/courier/drafts", { cache: "no-store" });
      if (!listing.ok) throw new Error("Could not refresh the handoff listing. Submission may have completed; reload before retrying.");
      const { items } = (await listing.json()) as { items: CourierDraft[] };
      setDrafts(items);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold">Your handoffs</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Choose a prepared delivery scan and sign it with your device key.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ProvenanceLabel>Seeded synthetic shipments</ProvenanceLabel>
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="courier-workspace mt-6">
      <section aria-label="Prepared delivery scans" className="min-w-0 overflow-hidden rounded-lg border bg-card">
        <div className="border-b p-5"><h2 className="text-sm font-semibold">Prepared delivery scans <Badge variant="secondary" className="ml-2">{drafts.length} drafts</Badge></h2></div>
      <ul>
        {drafts.map((draft) => (
          <li key={draft.draftId} className="border-b">
            <button type="button" aria-pressed={selected?.draftId === draft.draftId} onClick={() => setSelectedId(draft.draftId)} className={cn("w-full p-5 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary", selected?.draftId === draft.draftId && "bg-sidebar-accent")}>
              <span className="block text-sm font-semibold">{draft.title}</span>
              <span className="mt-3 flex items-center gap-2 font-mono text-xs"><Package aria-hidden="true" className="size-4 shrink-0" />{draft.waybillNo}</span>
              <span className="mt-2 flex items-start gap-2 text-xs text-muted-foreground"><MapPin aria-hidden="true" className="size-4 shrink-0" />{draft.recipientAddress}</span>
              <span className="mt-3 block font-mono text-xs text-muted-foreground">{draft.scenarioId} · {draft.leg}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="flex gap-2 p-5 text-xs leading-5 text-muted-foreground"><Shield aria-hidden="true" className="mt-0.5 size-4 shrink-0" />The courier supplies evidence and a device signature. The verifier owns the decision.</p>
      </section>
      {selected ? <DraftCard draft={selected} busy={busy} onSubmit={(signed) => submit(selected.draftId, signed)} /> : <p className="p-5 text-sm text-muted-foreground">No prepared delivery scans available.</p>}
      </div>
    </div>
  );
}

function DraftCard({
  draft,
  busy,
  onSubmit,
}: {
  draft: CourierDraft;
  busy: string | null;
  onSubmit: (signed: boolean) => void;
}) {
  const latest = draft.attempts.at(-1);
  const sealed = draft.attempts.some((attempt: Attempt) => attempt.outcome.sealed);

  return (
    <section aria-label="Selected handoff" className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b p-5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{draft.title}</h2>
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{draft.eventId}</p>
        </div>
        <Badge variant="outline" className="font-mono text-xs font-normal">
          {draft.scenarioId} · {draft.leg}
        </Badge>
      </div>
      <dl className="grid gap-5 border-b p-5 sm:grid-cols-3">
        <div className="min-w-0"><dt className="text-xs text-muted-foreground">Waybill</dt><dd className="mt-2 break-all font-mono text-xs">{draft.waybillNo}</dd></div>
        <div className="min-w-0"><dt className="text-xs text-muted-foreground">Recipient address</dt><dd className="mt-2 text-sm">{draft.recipientAddress}</dd></div>
        <div className="min-w-0"><dt className="text-xs text-muted-foreground">EPCIS leg</dt><dd className="mt-2 text-sm">{draft.leg} · {draft.scenarioId}</dd></div>
      </dl>
      <div className="p-5"><h3 className="flex items-center gap-2 text-sm font-semibold"><PenLine aria-hidden="true" className="size-4 text-primary" />Courier device signature</h3>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">The credential travels alongside the unchanged EPCIS event, never inside it.</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => onSubmit(true)} disabled={busy !== null}>
          <PenLine aria-hidden="true" className="size-4" />
          {sealed ? "Submit again" : "Sign and submit"}
        </Button>
        {!sealed && draft.attempts.length === 0 && (
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

      {latest && <OutcomePanel outcome={latest.outcome} />}
      {draft.attempts.length > 1 && <AttemptHistory attempts={draft.attempts} />}
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
function AttemptHistory({ attempts }: { attempts: Attempt[] }) {
  return (
    <div className="px-4 pb-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Submission history
      </div>
      <ol className="mt-2 flex flex-col gap-2">
        {attempts.map((attempt) => (
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

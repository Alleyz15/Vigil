"use client";

import { useState } from "react";
import { CheckCircle2, CircleAlert, CircleDashed, RotateCcw, ShieldCheck } from "lucide-react";
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

const TONE: Record<CourierOutcomeKind, { ring: string; text: string; Icon: typeof ShieldCheck }> = {
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
      const { items } = (await listing.json()) as { items: CourierDraft[] };
      setDrafts(items);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-2 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <ShieldCheck aria-hidden="true" className="size-5" />
        </span>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Courier handoffs</h1>
          <p className="text-sm text-muted-foreground">Submit a scan and sign it with your device key.</p>
        </div>
      </header>

      <div className="mb-8 flex flex-wrap items-center gap-2">
        <ProvenanceLabel>Seeded synthetic shipments</ProvenanceLabel>
        <ProvenanceLabel>Simulated identity · real Ed25519 signatures</ProvenanceLabel>
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      <ul className="flex flex-col gap-4">
        {drafts.map((draft) => (
          <DraftCard
            key={draft.draftId}
            draft={draft}
            busy={busy}
            onSubmit={(signed) => submit(draft.draftId, signed)}
          />
        ))}
      </ul>
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
    <li className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b px-4 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{draft.title}</h2>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{draft.waybillNo}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{draft.recipientAddress}</p>
        </div>
        <Badge variant="outline" className="font-mono text-xs font-normal">
          {draft.scenarioId} · {draft.leg}
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-4">
        <Button size="sm" onClick={() => onSubmit(true)} disabled={busy !== null}>
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

      {latest && <OutcomePanel outcome={latest.outcome} />}
      {draft.attempts.length > 1 && <AttemptHistory attempts={draft.attempts} />}
    </li>
  );
}

function OutcomePanel({ outcome }: { outcome: CourierOutcome }) {
  const tone = TONE[outcome.kind];
  const Icon = tone.Icon;

  return (
    <div className={cn("border-t px-4 py-4", tone.ring)}>
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", tone.text)} />
        <div className="min-w-0">
          <p className={cn("text-sm font-semibold", tone.text)}>{outcome.headline}</p>
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
    <div className="border-t px-4 py-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Submission history
      </div>
      <ol className="mt-2 flex flex-col gap-2">
        {attempts.map((attempt) => (
          <li key={attempt.run.run} className="flex items-baseline gap-2 text-xs">
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

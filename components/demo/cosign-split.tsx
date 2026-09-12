import { ArrowLeft, CheckCircle2, CircleDashed, ShieldAlert, XCircle } from "lucide-react";
import Link from "next/link";
import { IdentityBar } from "@/components/shells/identity-bar";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import { CosignActions } from "./cosign-actions";
import { COSIGN_STEPS, type CosignModel } from "@/lib/demo/cosign";
import { formatEvidenceValue } from "@/lib/display/evidence";
import { cn } from "@/lib/utils";

/**
 * Two people, side by side, on one handoff.
 *
 * THE SINGLE-FRAME TEST APPLIES HERE TOO: paused, with no audio and no
 * captions, a viewer must be able to say which pane is which WITHOUT reading
 * the labels. Colour alone will not do it in a compressed recording, so the two
 * sides are built to different shapes:
 *
 *   left   one narrow card floating on empty ground, sparse, large type
 *   right  full-bleed dense workspace, tabular figures, stacked sections
 *
 * That is the same contrast the real /courier and /operator surfaces have, for
 * the same reason — a handheld is not a workstation — so this view teaches the
 * shapes a viewer will see again on the real pages rather than inventing a
 * third visual language for the demo.
 */
export function CosignSplit({ model }: { model: CosignModel }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <TopRail model={model} />

      <div className="grid flex-1 grid-cols-1 lg:grid-cols-2">
        <CourierPane model={model} />
        <OperatorPane model={model} />
      </div>

      <CredentialBar model={model} />
    </div>
  );
}

/** The shared fact. One event id, printed once, above both panes. */
function TopRail({ model }: { model: CosignModel }) {
  const reached = COSIGN_STEPS.findIndex((step) => step.phase === model.phase);

  return (
    <div className="border-b px-6 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          {/*
            The back link lives INSIDE this container. Rendered above it by the
            page, it added its own height on top of `min-h-screen`, so the page
            was always taller than the viewport and the credential bar — the
            line carrying the whole argument — fell off the bottom of a 1080
            frame. Two rounds of trimming that bar did nothing, because the
            overflow was never the bar.
          */}
          <Link
            href="/operator/inbox"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft aria-hidden="true" className="size-3.5" />
            Back to the console
          </Link>
          <h1 className="mt-1 text-base font-semibold">One handoff. Two people. Two keys.</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Both panes read the same live workbench state. Neither signature alone assembles a
            valid credential.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <ProvenanceLabel>Seeded synthetic · real Ed25519 signatures</ProvenanceLabel>
        </div>

        <dl className="flex w-full flex-wrap items-baseline gap-x-6 gap-y-1 font-mono text-xs text-muted-foreground lg:w-auto">
          <div>
            <dt className="inline">event </dt>
            <dd className="inline text-foreground">{model.shared.eventId.slice(0, 8)}</dd>
          </div>
          <div>
            <dt className="inline">waybill </dt>
            <dd className="inline text-foreground">{model.shared.waybillNo}</dd>
          </div>
          {model.shared.eventHash && (
            <div>
              <dt className="inline">payload sha256 </dt>
              <dd className="inline text-foreground">{model.shared.eventHash.slice(0, 12)}…</dd>
            </div>
          )}
        </dl>
      </div>

      {/* The sequence, so a viewer landing mid-flow knows which beat they are on. */}
      <ol className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-xs">
        {COSIGN_STEPS.map((step, index) => {
          const done = reached >= 0 && index < reached;
          const here = step.phase === model.phase;
          return (
            <li
              key={step.phase}
              className={cn(
                "rounded-full px-2.5 py-1",
                here && "bg-foreground font-medium text-background",
                done && "bg-muted text-muted-foreground line-through",
                !here && !done && "text-muted-foreground",
              )}
            >
              {index + 1}. {step.label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * LEFT. A handheld: one card, floating, nothing else on the ground.
 *
 * There is no navigation and no queue, exactly as on `/courier`. The absence is
 * the fastest signal in the frame that this is not the console.
 */
function CourierPane({ model }: { model: CosignModel }) {
  const { courier } = model;

  return (
    <section
      aria-label="Courier"
      className="flex items-start justify-center border-b bg-muted/40 px-6 py-6 lg:border-b-0 lg:border-r"
    >
      <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-background shadow-sm">
        <IdentityBar identity={courier.identity} />

        <div className="p-5">
          <p className="font-mono text-xs text-muted-foreground">{model.shared.waybillNo}</p>
          <h2 className="mt-1 text-base font-semibold leading-snug">{courier.headline}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{courier.detail}</p>

          <dl className="mt-5 space-y-2 text-sm">
            <Row label="Leg" value={model.shared.leg} />
            <Row label="Scanned" value={model.shared.eventTime.replace("T", " ").slice(0, 16)} />
            <Row
              label="Signed with"
              value={courier.identity.keyFingerprint ?? "—"}
              mono
            />
          </dl>

          {/*
            The verifier's own words, not our summary of them. A courier being
            told their signature is insufficient deserves the actual reason.
          */}
          {courier.problems.length > 0 && (
            <ul className="mt-5 space-y-2 rounded-md bg-amber-500/10 p-3 text-xs leading-5 text-amber-700 dark:text-amber-400">
              {courier.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}

          <div className="mt-5">
            <CosignActions model={model} side="courier" />
          </div>

          {courier.attempts > 0 && (
            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              {courier.attempts === 1
                ? "One submission. The same bytes will be run again when an operator co-signs."
                : `${courier.attempts} submissions of the identical event.`}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * RIGHT. A workstation: full-bleed, dense, stacked sections, tabular figures.
 *
 * The two axes are printed as two numbers and never as one. Rule 2 is not a
 * display convention here — a viewer who reads a single combined risk score has
 * been shown a different system.
 */
function OperatorPane({ model }: { model: CosignModel }) {
  const { operator } = model;

  if (!operator.queued) {
    return (
      <section aria-label="Operator" className="bg-background">
        <IdentityBar identity={operator.identity} />
        <div className="px-6 py-8">
          <h2 className="text-base font-semibold">Nothing to co-sign</h2>
          <p className="mt-2 max-w-prose text-sm leading-6 text-muted-foreground">
            The courier has not submitted. There is no case in the queue, no verdict, and nothing
            for an operator to put their name to — which is the honest state, not an empty panel
            waiting to be filled.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Operator" className="bg-background">
      <IdentityBar identity={operator.identity} />

      <div className="space-y-6 px-6 py-6">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Two axes, never summed
          </h2>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Axis label="Single-event" axis={operator.inconsistency} />
            <Axis label="Pattern" axis={operator.pattern} />
          </div>
          {operator.coverageLine && (
            <p className="mt-2 text-xs text-muted-foreground">{operator.coverageLine}</p>
          )}
        </div>

        {operator.gate && (
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Gate
            </h2>
            <p className="mt-2 text-sm">
              <span className="font-semibold uppercase">{operator.gate.decision}</span>
              {operator.gate.matrixCell && (
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {operator.gate.matrixCell}
                </span>
              )}
            </p>
            {operator.gate.rationale && (
              <p className="mt-1 max-w-prose text-sm leading-6 text-muted-foreground">
                {operator.gate.rationale}
              </p>
            )}
            {operator.gate.cosignReasons.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm leading-6">
                {operator.gate.cosignReasons.map((reason) => (
                  <li key={reason} className="flex gap-2">
                    <ShieldAlert aria-hidden="true" className="mt-1 size-3.5 shrink-0" />
                    {reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {operator.flags.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              What contradicted what
            </h2>
            <table className="mt-2 w-full text-sm">
              <tbody>
                {operator.flags.map((flag) => (
                  <tr key={flag.id} className="align-top">
                    <td className="py-1.5 pr-3 font-mono text-xs">{flag.id}</td>
                    <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">
                      +{flag.points}
                    </td>
                    <td className="py-1.5">
                      {flag.label}
                      {flag.evidence.length > 0 && (
                        <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                          {flag.evidence
                            .slice(0, 2)
                            .map((item) => `${item.field}=${formatEvidenceValue(item.value)}`)
                            .join("  ")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <CosignActions model={model} side="operator" />
      </div>
    </section>
  );
}

/**
 * The bar under both panes: what the two halves currently add up to.
 *
 * It spans the full width because the credential is the thing that joins the
 * two sides, and putting it inside either pane would make it look like one
 * person's view of the other.
 */
function CredentialBar({ model }: { model: CosignModel }) {
  const { credential, ledger, arithmetic } = model;

  return (
    <div className="border-t bg-muted/40 px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Half ok={credential?.courierValid ?? false} label="courier" />
            <span aria-hidden="true" className="text-muted-foreground">
              +
            </span>
            <Half ok={credential?.operatorValid ?? false} label="operator" />
            <span aria-hidden="true" className="text-muted-foreground">
              =
            </span>
            <span
              className={cn(
                "rounded-md px-2.5 py-1 text-sm font-semibold",
                credential?.valid
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                  : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
              )}
            >
              {credential?.valid ? "credential verifies" : "not a valid credential"}
            </span>
          </div>

          <p className="mt-2 text-sm font-medium">{arithmetic.headline}</p>
          <p className="text-xs leading-5 text-muted-foreground">{arithmetic.detail}</p>
        </div>

        <div className="text-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Ledger
          </h2>
          {ledger?.sealed ? (
            <p className="mt-1.5 leading-6">
              Sealed at sequence <span className="font-mono">{ledger.sequence}</span>
              <span className="block text-muted-foreground">
                {ledger.entries} records, chain {ledger.chainValid ? "intact" : "BROKEN"}
              </span>
            </p>
          ) : (
            <p className="mt-1.5 leading-6">
              <span className="font-semibold">Nothing sealed</span>
              <span className="block text-muted-foreground">
                A halt writes no entry. Sealing here would record a decision nobody made.
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Half({ ok, label }: { ok: boolean; label: string }) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium",
        ok
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          : "bg-muted text-muted-foreground",
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {label} signature
    </span>
  );
}

/**
 * One axis, or an honest statement that it could not be evaluated.
 *
 * A null score is never drawn as a zero. Rule 3e: an unmeasured axis rendered
 * at the origin claims a measurement nobody made.
 */
function Axis({ label, axis }: { label: string; axis: CosignModel["operator"]["inconsistency"] }) {
  return (
    <div className="rounded-md bg-muted/60 px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      {axis && axis.score !== null ? (
        <div className="mt-0.5 text-2xl font-semibold tabular-nums">{axis.score}</div>
      ) : (
        <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
          <CircleDashed aria-hidden="true" className="size-3.5" />
          not evaluated
        </div>
      )}
      {axis?.reason && <p className="mt-1 text-xs leading-4 text-muted-foreground">{axis.reason}</p>}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 truncate text-right", mono && "font-mono text-xs")}>{value}</dd>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CloudRain, Link2, Map, MapPinned, MessageSquareText, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { HandoffDetail } from "@/lib/workbench";
import { formatEvidenceValue } from "@/lib/display/evidence";
import { cn } from "@/lib/utils";
import { AxisPair } from "./axis-pair";
import {
  detailStatusMessage,
  ledgerReferencePresentation,
  primaryFlagCard,
  shouldShowEvidenceDetails,
  traceNodeStates,
} from "./handoff-detail-model";
import { OperatorActions } from "./operator-actions";
import { ProvenanceLabel } from "./provenance-label";
import { PlanAlternatives, RerouteAlternatives } from "./rejected-alternatives";
import { ShipmentMap } from "./shipment-map";
import { HandoffStateBadge } from "./status-badge";
import { StreamView } from "@/components/console/stream-view";

function sentence(value: string | null): string {
  return value?.replaceAll("_", " ") ?? "Unavailable";
}

export function HandoffDetailView({
  detail: initialDetail,
  backLink = { href: "/operator/inbox", label: "Back to inbox" },
}: {
  detail: HandoffDetail;
  backLink?: { href: string; label: string };
}) {
  const [detail, setDetail] = useState(initialDetail);
  const [activeLegIndex, setActiveLegIndex] = useState(detail.summary.legIndex);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const status = detailStatusMessage(detail.summary);
  const ledger = ledgerReferencePresentation(detail.ledger.sequence);
  const latestRun = detail.runs.at(-1);
  const trace = useMemo(() => traceNodeStates(latestRun?.trace ?? []), [latestRun?.trace]);
  const showEvidenceDetails = shouldShowEvidenceDetails({
    flagCount: detail.flags.length,
    hasAddressCorrection: Boolean(detail.addressCorrection),
    hasLocationGap: Boolean(detail.locationEvidence),
  });
  const revealOverlays = activeLegIndex >= detail.summary.legIndex;
  const rerouteAvailable = detail.reroute?.status === "proposed";
  const rerouteReason = detail.reroute?.status === "proposed"
    ? "An authorised reroute is available."
    : detail.reroute?.reason ?? "No authorised reroute exists for this address.";
  const rerouteTarget = detail.reroute?.status === "proposed"
    ? detail.reroute.proposal.kind === "pickup_point"
      ? detail.reroute.proposal.target.label
      : detail.reroute.proposal.target.courierId
    : null;
  const primaryFlag = primaryFlagCard(detail.flags);

  return (
    <div className="space-y-6">
      <div className="flex min-h-16 items-center gap-4">
        <Button nativeButton={false} variant="ghost" size="icon-sm" render={<Link href={backLink.href} aria-label={backLink.label} />}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-mono text-2xl font-bold">{detail.summary.parcel.waybillNo}</h1>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {detail.summary.courier.displayName} · {detail.summary.bizStep} · scenario {detail.summary.scenarioId} · event {detail.summary.eventId.slice(0, 4)}…{detail.summary.eventId.slice(-4)}
          </p>
        </div>
        <HandoffStateBadge state={detail.summary.state} provenance={detail.summary.stateProvenance} decision={detail.summary.decision} />
        <Badge variant="secondary">{detail.summary.sealed ? "sealed" : "nothing sealed"}</Badge>
        <div className="flex h-9 min-w-36 items-center justify-center gap-2 rounded-md border bg-muted/60 px-3 text-xs font-semibold">
          <Link2 className="size-3.5" aria-hidden="true" />
          {ledger.label}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_23rem] items-start gap-5">
        <div className="min-w-0 space-y-3">
          <section className="relative overflow-hidden rounded-lg border bg-card">
            <div className="absolute left-3 top-3 z-[600] flex items-center gap-2 rounded-md border bg-white/95 px-3 py-2 text-xs font-semibold shadow-sm">
              <Map className="size-3.5 text-primary" aria-hidden="true" />
              coordinate-bearing evidence only
            </div>
            <ShipmentMap
              model={detail.map}
              activeLegIndex={activeLegIndex}
              revealOverlays={revealOverlays}
              selectedEvidenceId={selectedEvidenceId}
              onSelectEvidence={setSelectedEvidenceId}
            />
          </section>

          <div className="space-y-2 text-xs leading-5 text-muted-foreground">
            <ProvenanceLabel>Synthetic cell / WiFi references · not real observations</ProvenanceLabel>
            <p>Reference signals are derived from the cached address set. GPS and reference-signal contradictions in this demo illustrate the mechanism using simulated evidence, not field measurements.</p>
          </div>

          <ol className="grid grid-cols-6 gap-1.5" aria-label="Shipment legs">
            {detail.timeline.map((leg) => {
              const active = leg.legIndex === activeLegIndex;
              return (
                <li key={leg.eventId} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => setActiveLegIndex(leg.legIndex)}
                    className={cn(
                      "h-[5.25rem] w-full rounded-md border bg-card px-2 py-2 text-left transition-colors hover:bg-muted",
                      active && "border-primary bg-accent",
                    )}
                  >
                    <span className="block text-xs font-medium text-muted-foreground">{active && leg.legIndex === detail.summary.legIndex ? "review" : "clear"}</span>
                    <span className="mt-1 block truncate text-xs font-semibold capitalize">{leg.bizStep}</span>
                    <span className="mt-1 block font-mono text-xs text-muted-foreground">{leg.eventTime.slice(11, 16)}</span>
                  </button>
                </li>
              );
            })}
          </ol>

          <section className="space-y-2" aria-label="Contradiction evidence">
            {detail.flags.length === 0 ? (
              <div className="rounded-md border bg-card px-4 py-3 text-xs text-muted-foreground">No contradiction flags were raised.</div>
            ) : detail.flags.map((flag) => (
              <button
                key={flag.id}
                type="button"
                onClick={() => setSelectedEvidenceId(flag.id)}
                className={cn(
                  "flex w-full items-center gap-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-left transition-shadow",
                  selectedEvidenceId === flag.id && "ring-2 ring-red-300/60",
                )}
              >
                <Badge variant="outline" className="border-red-200 bg-red-100 font-mono text-red-700">{flag.id}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold text-red-950">{flag.label}</span>
                  <span className="mt-0.5 block truncate text-xs text-red-800/70">Select to focus the corresponding map evidence</span>
                </span>
                <span className="text-xs font-medium text-red-700">map focus</span>
              </button>
            ))}
          </section>

          <section className="rounded-lg border bg-card p-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-sm font-semibold">Agent trace</h2>
              <div className="flex items-center gap-3">
                <ProvenanceLabel>frozen SSE contract</ProvenanceLabel>
                <span className="text-xs text-muted-foreground">model can explain, never decide</span>
              </div>
            </div>
            <ol className="mt-3 grid grid-cols-8 gap-1.5">
              {trace.map((node) => (
                <li key={node.node} className={cn("min-w-0 rounded-md border px-1.5 py-2 text-center", node.node === "gate" && "border-primary bg-accent")}>
                  <span className="block min-h-8 break-words font-mono text-xs font-semibold leading-4">{node.node.replace("fetch_history", "fetch history").replace("external_context", "external context")}</span>
                  <Badge variant="secondary" className="mt-1 h-auto max-w-full whitespace-normal px-1 py-1 text-xs leading-3">{node.status === "pending" ? "not reached" : node.status}</Badge>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="space-y-3">
          <section className="rounded-lg border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Decision and credential</h2>
              <ProvenanceLabel>{detail.summary.sealed ? "sealed" : "pending"}</ProvenanceLabel>
            </div>

            <div className={cn(
              "mt-4 rounded-md border px-3 py-2.5 text-xs leading-4",
              status.tone === "pending" && "border-amber-300 bg-amber-50 text-amber-950",
              status.tone === "alert" && "border-red-200 bg-red-50 text-red-950",
              status.tone === "accepted" && "border-emerald-200 bg-emerald-50 text-emerald-950",
              status.tone === "resolved" && "bg-muted",
            )}>
              <span className="font-semibold capitalize">Gate result: {sentence(detail.gate.decision)}.</span>{" "}{status.detail}
            </div>

            <div className="mt-3">
              <AxisPair
                variant="feature"
                inconsistency={detail.summary.inconsistency}
                pattern={detail.summary.pattern}
                coverageLine={detail.summary.coverageLine}
              />
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <CredentialHalf label="Courier half" value={detail.credential?.courierValid ? "valid" : "missing"} valid={Boolean(detail.credential?.courierValid)} />
              <CredentialHalf label="Operator half" value={detail.credential?.operatorValid ? "valid" : "missing"} valid={Boolean(detail.credential?.operatorValid)} />
            </div>

            {detail.summary.requiresCosign && <CosignReason detail={detail} />}

            <div className="mt-3">
              <OperatorActions
                eventId={detail.summary.eventId}
                state={detail.summary.state}
                rerouteAvailable={rerouteAvailable}
                rerouteReason={rerouteReason}
                sealed={detail.summary.sealed}
                onDetailChange={setDetail}
              />
            </div>
          </section>

          {primaryFlag && (
            <StatusCard
              code={primaryFlag.code}
              title={primaryFlag.title}
              detail={primaryFlag.evidence ? `${primaryFlag.evidence.field} = ${formatEvidenceValue(primaryFlag.evidence.value)}` : undefined}
              source="engine"
              tone="alert"
            />
          )}
          <StatusCard code="R1" title={rerouteAvailable ? "Reroute proposed" : "Reroute unavailable"} detail={rerouteAvailable ? rerouteTarget ?? "authorised proposal" : "no proposal in this run"} source={rerouteAvailable ? "available" : "unavailable"} />
          <StatusCard code="WX" title={detail.externalContext?.status === "available" ? "Weather context" : "Weather not selected"} detail={detail.externalContext?.summary ?? "planner did not request it"} source={detail.externalContext?.status === "available" ? "available" : "not used"} tone="info" />
        </aside>
      </div>

      <div className="space-y-4 border-t pt-6">
        {showEvidenceDetails && <section>
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Evidence details</h2>
            <span className="text-xs text-muted-foreground">Backend values used by the deterministic engine</span>
          </div>
          <div className="mt-3 space-y-2">
            {detail.abortEvidence && <AbortEvidenceNotice detail={detail} />}
            {detail.locationEvidence && <LocationEvidenceNotice detail={detail} />}
            {detail.addressCorrection && <AddressCorrectionNotice detail={detail} />}
            {detail.flags.map((flag) => (
              <div key={flag.id} className="rounded-md border bg-card px-4 py-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="font-mono">{flag.id}</Badge>
                  <span className="text-sm font-semibold">{flag.label}</span>
                  <span className="ml-auto font-mono text-xs tabular-nums">+{flag.points}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {flag.evidence.map((evidence, index) => (
                    <span key={`${evidence.field}-${index}`} className="min-w-0 break-all text-xs text-muted-foreground">
                      <span className="font-mono text-foreground">{evidence.field}</span> = {formatEvidenceValue(evidence.value)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>}

        <div className="grid grid-cols-3 items-start gap-4 [grid-auto-flow:dense]">
          <section className="rounded-md bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Agent explanation</h2>
              <ProvenanceLabel>{detail.explanation.source}</ProvenanceLabel>
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{detail.explanation.text ?? "No explanation was produced."}</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {detail.explanation.source === "model"
                ? `Model ${detail.explanation.modelId ?? "unknown"} produced this prose.`
                : detail.explanation.rejection ?? detail.explanation.runtimeReason ?? "Deterministic structured fallback."}
            </p>
          </section>

          {detail.recipientConfirmation && (
            <section className="rounded-md bg-card p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <MessageSquareText className="size-4" aria-hidden="true" />
                <h2 className="text-sm font-semibold">Recipient confirmation</h2>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Scoped one-time capability. Current state: <span className="font-medium text-foreground">{sentence(detail.recipientConfirmation.state.status)}</span>.
              </p>
              <Button
                nativeButton={false}
                variant="outline"
                className="mt-3 w-full"
                render={<Link href={`/confirm/${encodeURIComponent(detail.recipientConfirmation.tokenId)}`} />}
              >
                Open recipient link
                <ArrowRight data-icon="inline-end" />
              </Button>
            </section>
          )}

          <section className="rounded-md bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2"><CloudRain className="size-4" /><h2 className="text-sm font-semibold">External context</h2></div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {detail.externalContext?.summary ?? "Weather was not selected for this run."}
            </p>
            {detail.externalContext?.status === "available" && (
              <p className="mt-2 text-xs leading-4 text-muted-foreground">Open-Meteo archive · approximately 9 km reanalysis · regional context, not an observation at the address.</p>
            )}
          </section>

          <section className="rounded-md bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2"><ShieldAlert className="size-4" /><h2 className="text-sm font-semibold">Reroute</h2></div>
            {detail.reroute?.status === "proposed" ? (
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Proposed {detail.reroute.proposal.kind.replaceAll("_", " ")} · {rerouteTarget}. Approval state: {sentence(detail.reroute.proposal.approvalState)}.
              </p>
            ) : (
              <p className="mt-2 text-xs font-medium leading-5 text-muted-foreground">{rerouteReason}</p>
            )}
            <div className="mt-4 border-t pt-4">
              <RerouteAlternatives reroute={detail.reroute ?? null} />
            </div>
          </section>

          {/*
            WHAT THE AGENT CONSIDERED AND DID NOT CHOOSE.
            Sits next to the outcome rather than in a separate view, because the
            option set is only meaningful beside the option taken.
          */}
          <section className="col-span-2 rounded-md bg-card p-4 shadow-sm">
            <PlanAlternatives
              considered={detail.planConsidered}
              source={detail.plan.source}
              selectedTools={detail.plan.selectedTools}
            />
          </section>

          <section className="rounded-md bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2"><Link2 className="size-4" /><h2 className="text-sm font-semibold">Seal and ledger</h2></div>
            <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-y-2 text-xs">
              <dt className="text-muted-foreground">Ledger sequence</dt><dd className="font-mono">{detail.ledger.sequence ?? "not written"}</dd>
              <dt className="text-muted-foreground">Chain</dt><dd className="font-medium">{detail.ledger.chainValid ? `intact across ${detail.ledger.entries} records` : "broken"}</dd>
              <dt className="text-muted-foreground">Pipeline runs</dt><dd className="font-mono">{detail.runs.length}</dd>
            </dl>
          </section>
        </div>
      </div>

      <details className="mt-8 rounded-md bg-card px-4 py-3 shadow-sm">
        <summary className="cursor-pointer text-sm font-semibold">Raw synthetic EPCIS event</summary>
        <pre className="mt-3 max-h-96 overflow-auto text-xs leading-5 text-muted-foreground">{JSON.stringify(detail.event, null, 2)}</pre>
      </details>

      <section className="mt-8 border-t pt-8">
        <h2 className="text-base font-semibold">Replay this event through the live agent</h2>
        <p className="mt-1 mb-4 text-xs leading-5 text-muted-foreground">
          Native EventSource streams the frozen eight-node contract. Prior legs are replayed first to rebuild courier history; the browser never computes the verdict.
        </p>
        <StreamView
          scenarioId={detail.summary.scenarioId}
          legCount={detail.timeline.length}
          defaultLeg={detail.summary.legIndex}
        />
      </section>
    </div>
  );
}

function CredentialHalf({ label, value, valid }: { label: string; value: string; valid: boolean }) {
  return (
    <div className={cn(
      "rounded-md border px-3 py-2.5",
      valid ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50",
    )}>
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <KeyRoundIcon valid={valid} />
        {label}
      </div>
      <div className={cn("mt-1 font-mono text-xs font-semibold", valid ? "text-emerald-700" : "text-amber-700")}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">binds event + nonce</div>
    </div>
  );
}

function KeyRoundIcon({ valid }: { valid: boolean }) {
  return <span aria-hidden="true" className={cn("size-2 rounded-full", valid ? "bg-emerald-600" : "border border-amber-600")} />;
}

function StatusCard({
  code,
  title,
  detail,
  source,
  tone = "neutral",
}: {
  code: string;
  title: string;
  detail?: string;
  source: string;
  tone?: "neutral" | "alert" | "info";
}) {
  return (
    <section className="grid min-h-[3.9rem] grid-cols-[3.4rem_minmax(0,1fr)_5.25rem] items-center gap-2 rounded-lg border bg-card px-3 py-2.5">
      <Badge
        variant="secondary"
        className={cn(
          "justify-center font-mono text-xs",
          tone === "alert" && "bg-red-100 text-red-700",
          tone === "info" && "bg-blue-100 text-blue-700",
        )}
      >
        {code}
      </Badge>
      <div className="min-w-0">
        <div className="truncate text-xs font-semibold">{title}</div>
        {detail && <div className="mt-0.5 truncate text-xs text-muted-foreground" title={detail}>{detail}</div>}
      </div>
      <Badge variant="secondary" className="justify-center truncate px-1.5 text-xs text-muted-foreground">{source}</Badge>
    </section>
  );
}

function formatSen(value: number | string | null): string {
  return typeof value === "number"
    ? new Intl.NumberFormat("en-MY", { style: "currency", currency: "MYR" }).format(value / 100)
    : "unavailable";
}

function CosignReason({ detail }: { detail: HandoffDetail }) {
  return (
    <section className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950">
      <h3 className="text-xs font-semibold">Why a co-signature is required</h3>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5">
        {detail.gate.cosignReasons.map((reason) => <li key={reason}>{reason}</li>)}
      </ul>
      {detail.cosignPolicyEvidence.length > 0 && (
        <div className="mt-2 border-t border-amber-200 pt-2">
          <p className="text-xs font-medium">Mandate conditions on file · actual / threshold</p>
        <dl className="mt-1 space-y-1 text-xs">
          {detail.cosignPolicyEvidence.map((item) => (
            <div key={item.kind} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
              <dt className="break-words">{item.kind.replaceAll("_", " ")}</dt>
              <dd className="font-mono text-right">
                {item.kind === "parcel_value_over_sen"
                  ? `${formatSen(item.actual)} / ${formatSen(item.threshold)}`
                  : item.threshold === null
                    ? String(item.actual ?? "unavailable")
                    : `${item.actual ?? "unavailable"} / ${item.threshold}`}
              </dd>
            </div>
          ))}
        </dl>
        </div>
      )}
    </section>
  );
}

function AbortEvidenceNotice({ detail }: { detail: HandoffDetail }) {
  const abort = detail.abortEvidence!;
  return (
    <section className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-red-950">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="border-red-200 bg-red-100 font-mono text-red-700">{abort.ruleId}</Badge>
        <h3 className="text-sm font-semibold">Event ID reused with a different payload</h3>
      </div>
      <p className="mt-2 text-xs leading-5">
        The ledger already bound event <span className="font-mono">{abort.eventId}</span> to one payload.
        This submission reused it with different content, so the ledger aborted before the engine ran.
      </p>
      <dl className="mt-2 grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt>Bound payload</dt><dd className="break-all font-mono">{abort.boundPayloadHash}</dd>
        <dt>Submitted payload</dt><dd className="break-all font-mono">{abort.submittedPayloadHash}</dd>
      </dl>
    </section>
  );
}

/**
 * Why the distance check fired, when the courier did nothing wrong.
 *
 * WITHOUT THIS AN OPERATOR SEES A FLAG AND A RULE ID. I10 says "the delivery
 * scan is far from the recipient address", which is true, and leaves them to
 * conclude the courier delivered somewhere else. The cause is that the address
 * changed after the parcel was already in transit and the registry the check
 * compared against predates that.
 *
 * THE CORRECTION IS NOT AN ENGINE INPUT. The verdict was reached without it —
 * the engine only ever compared a scan position against a stored coordinate. If
 * it had been told a correction happened, the flag would be the system
 * detecting a condition it was handed, and the whole demonstration circular.
 * This panel is assembled from an independent record, which is exactly what an
 * explanation is allowed to be.
 *
 * Session 10 measured mid-route address correction as the LEADING
 * false-positive contributor at noise level 1. Known Limitations states that
 * the system is as sensitive to stale records as to fraud; this is where a
 * viewer watches it happen and sees it named.
 */
/**
 * A location nobody registered reference sites for.
 *
 * WORDED TO THE MECHANISM: the engine never searches for towers near a point; it
 * looks up the IDs a handset reported, and an arbitrary point's IDs are not in
 * the registry. The evaluable-check line is this handoff's own, read from its
 * result — never a number written down for "arbitrary points", which would be
 * wrong the first time a scan differed.
 */
function LocationEvidenceNotice({ detail }: { detail: HandoffDetail }) {
  const evidence = detail.locationEvidence!;
  return (
    <section className="rounded-md border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{evidence.gap.summary}</h2>
        <ProvenanceLabel>Scan position simulated</ProvenanceLabel>
        {evidence.boundary.placeholder && <ProvenanceLabel>Boundary data pending confirmation</ProvenanceLabel>}
      </div>
      {/* ODbL requires the credit wherever the data is used; it travels with the boundary. */}
      <p className="mt-1.5 font-mono text-xs text-muted-foreground">{evidence.boundary.attribution}</p>
      <p className="mt-1.5 max-w-prose text-xs leading-5 text-muted-foreground">{evidence.gap.detail}</p>
      {detail.summary.coverageLine && (
        <p className="mt-2 font-mono text-xs text-foreground">This handoff: {detail.summary.coverageLine}</p>
      )}
    </section>
  );
}

function AddressCorrectionNotice({ detail }: { detail: HandoffDetail }) {
  const correction = detail.addressCorrection!;
  const at = correction.correctedAt.replace("T", " ").slice(0, 16);

  return (
    <section className="rounded-md bg-sky-500/10 px-4 py-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-sky-900 dark:text-sky-200">
        <MapPinned aria-hidden="true" className="size-4 shrink-0" />
        A stale record, not a false delivery
      </h2>

      <p className="mt-1.5 max-w-prose text-xs leading-5 text-sky-900/90 dark:text-sky-200/90">
        The sender corrected this parcel&apos;s address at <span className="font-mono">{at}</span>,
        after it was already in transit — from{" "}
        <span className="font-medium">{correction.fromLabel}</span> to{" "}
        <span className="font-medium">{correction.toLabel}</span>. The courier delivered to the
        corrected address. The distance check compared their scan against the delivery point
        captured at dispatch, which predates the correction, so the two disagree for a reason
        neither the courier nor the recipient caused.
      </p>

      {/*
        WHY A HUMAN IS BEING ASKED, derived from the gate rather than asserted.
        Nobody built a path that sends stale-record deliveries to an operator:
        the mandate's co-signature rules did it. The sentence only appears when
        the gate actually required a signature, and quotes the gate's reason.
      */}
      {detail.credential?.cosignRequired && detail.gate.cosignReasons.length > 0 && (
        <p className="mt-2 max-w-prose text-xs leading-5 text-sky-900/90 dark:text-sky-200/90">
          <span className="font-medium">That is why you are being asked to sign.</span>{" "}
          {detail.gate.cosignReasons[0]} Nobody designed this path for corrected addresses — the
          courier&apos;s mandate already requires a human signature whenever the machine cannot
          resolve a contradiction on its own, the same rule that covers a courier with no history.
        </p>
      )}

      <p className="mt-2 max-w-prose text-xs leading-5 text-sky-900/70 dark:text-sky-200/70">
        Nothing told the engine a correction had happened; it compared a scan position against a
        stored coordinate and found them apart. This panel is assembled from the correction record
        afterwards, which is why it explains the verdict rather than producing it.
      </p>
    </section>
  );
}

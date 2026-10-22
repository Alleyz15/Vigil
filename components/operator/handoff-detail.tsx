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
  acceptanceExplanation,
  attemptHistoryLabel,
  citationTarget,
  detailStatusMessage,
  ledgerReferencePresentation,
  primaryFlagCard,
  planPresentation,
  shouldShowEvidenceDetails,
  traceNodeStates,
} from "./handoff-detail-model";
import { OperatorActions } from "./operator-actions";
import { ProvenanceLabel } from "./provenance-label";
import { PlanAlternatives, RerouteAlternatives } from "./rejected-alternatives";
import { ShipmentMap } from "./shipment-map";
import { HandoffStateBadge } from "./status-badge";
import { SimulatedClockLabel } from "./simulated-clock-label";
import { StreamView } from "@/components/console/stream-view";
import { OperatorJourneySummary } from "@/components/shipment/route-summary";

function sentence(value: string | null): string {
  return value?.replaceAll("_", " ") ?? "Unavailable";
}

export function HandoffDetailView({
  detail: initialDetail,
  backLink = { href: "/operator/inbox", label: "Back to inbox" },
  clockAnchorIso,
}: {
  detail: HandoffDetail;
  backLink?: { href: string; label: string };
  clockAnchorIso?: string;
}) {
  const [detail, setDetail] = useState(initialDetail);
  const [activeLegIndex, setActiveLegIndex] = useState(detail.summary.legIndex);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [aiTab, setAiTab] = useState<"model" | "fallback">("model");
  const status = detailStatusMessage(detail.summary);
  const ledger = ledgerReferencePresentation(detail.ledger.sequence);
  const trace = useMemo(() => traceNodeStates(detail.authoritativeRun.trace), [detail.authoritativeRun.trace]);
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
  const valueCondition = detail.cosignPolicyEvidence.find((item) => item.kind === "parcel_value_over_sen");
  const whyAccepted = acceptanceExplanation({
    decision: detail.gate.decision,
    inconsistencyScore: detail.summary.inconsistency.score,
    inconsistencyCoverage: detail.summary.coverageLine,
    patternScore: detail.summary.pattern.score,
    patternCoverage: detail.summary.patternCoverageLine ?? null,
    declaredValueSen: typeof valueCondition?.actual === "number" ? valueCondition.actual : null,
    valueThresholdSen: valueCondition?.threshold ?? null,
    courierSignatureValid: Boolean(detail.credential?.courierValid),
    requiresCosign: detail.summary.requiresCosign,
  });

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
        <SimulatedClockLabel anchorIso={clockAnchorIso} />
      </div>

      {detail.route && (
        <section aria-label="Shipment route" className="border-y bg-card px-4 py-3">
          <OperatorJourneySummary route={detail.route} />
        </section>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_23rem] items-start gap-5">
        <div className="min-w-0 space-y-3">
          <section className="relative overflow-hidden rounded-lg border bg-card">
            <div className="absolute left-3 top-3 z-[600] flex items-center gap-2 rounded-md border bg-white/95 px-3 py-2 text-xs font-semibold shadow-sm">
              <Map className="size-3.5 text-primary" aria-hidden="true" />
              places and coordinate evidence · no navigation route
            </div>
            <ShipmentMap
              model={detail.map}
              activeLegIndex={activeLegIndex}
              revealOverlays={revealOverlays}
              selectedEvidenceId={selectedEvidenceId}
              onSelectEvidence={setSelectedEvidenceId}
            />
          </section>

          <MapProvenance detail={detail} />

          <ol className="grid grid-cols-6 gap-1.5" aria-label="Shipment legs">
            {detail.timeline.map((leg) => {
              const active = leg.legIndex === activeLegIndex;
              return (
                <li key={leg.eventId} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => setActiveLegIndex(leg.legIndex)}
                    className={cn(
                      "h-[6.5rem] w-full rounded-md border bg-card px-2 py-2 text-left transition-colors hover:bg-muted",
                      active && "border-primary bg-accent",
                    )}
                  >
                    <span className="block text-xs font-medium text-muted-foreground">{active && leg.legIndex === detail.summary.legIndex ? "review" : "clear"}</span>
                    <span className="mt-1 block truncate text-xs font-semibold capitalize">{leg.bizStep}</span>
                    {leg.locationLabel && <span className="mt-1 block line-clamp-2 text-xs leading-4 text-muted-foreground">{leg.locationLabel}</span>}
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
          <section id="decision-and-credential" className="rounded-lg border bg-card p-4">
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

            {whyAccepted && (
              <section className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-emerald-950">
                <h3 className="text-xs font-semibold">Why accepted</h3>
                <p className="mt-1 text-xs leading-5">{whyAccepted}</p>
              </section>
            )}

            <div className="mt-3 grid grid-cols-2 gap-2">
              <CredentialHalf label="Courier half" value={detail.credential?.courierValid ? "valid" : "missing"} valid={Boolean(detail.credential?.courierValid)} />
              <CredentialHalf
                label="Operator half"
                value={detail.credential?.operatorValid ? "valid" : detail.summary.requiresCosign ? "missing" : "not required"}
                valid={Boolean(detail.credential?.operatorValid)}
                neutral={!detail.credential?.operatorValid && !detail.summary.requiresCosign}
              />
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
        {showEvidenceDetails && <section id="evidence-details">
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
          <AiInvestigation
            detail={detail}
            tab={aiTab}
            onTabChange={setAiTab}
            onEvidenceSelect={setSelectedEvidenceId}
          />

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

          <section id="seal-and-ledger" className="rounded-md bg-card p-4 shadow-sm">
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

          <section className="rounded-md bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2"><Link2 className="size-4" /><h2 className="text-sm font-semibold">Seal and ledger</h2></div>
            <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-y-2 text-xs">
              <dt className="text-muted-foreground">Ledger sequence</dt><dd className="font-mono">{detail.ledger.sequence ?? "not written"}</dd>
              <dt className="text-muted-foreground">Chain</dt><dd className="font-medium">{detail.ledger.chainValid ? `intact across ${detail.ledger.entries} records` : "broken"}</dd>
              <dt className="text-muted-foreground">Pipeline runs</dt><dd className="font-mono">{detail.runs.length}</dd>
            </dl>
          </section>

          {detail.runs.length > 1 && <AttemptHistory runs={detail.runs} authoritativeRun={detail.authoritativeRun.run} />}
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

function MapProvenance({ detail }: { detail: HandoffDetail }) {
  if (detail.locationEvidence) {
    return (
      <div className="space-y-2 text-xs leading-5 text-muted-foreground">
        <ProvenanceLabel>No cell or WiFi reference supplied</ProvenanceLabel>
        <p>
          No cell or WiFi reference was supplied for this arbitrary location. I1 was not evaluated;
          the simulator did not invent reference IDs.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2 text-xs leading-5 text-muted-foreground">
      <ProvenanceLabel>Synthetic cell / WiFi references · not real observations</ProvenanceLabel>
      <p>
        Reference signals are derived from the cached address set. GPS and reference-signal
        contradictions illustrate the mechanism using simulated evidence, not field measurements.
      </p>
    </div>
  );
}

function AiInvestigation({
  detail,
  tab,
  onTabChange,
  onEvidenceSelect,
}: {
  detail: HandoffDetail;
  tab: "model" | "fallback";
  onTabChange: (tab: "model" | "fallback") => void;
  onEvidenceSelect: (id: string | null) => void;
}) {
  const modelId = detail.explanation.modelId ?? detail.plan.modelId;
  const selectedCount = detail.plan.selectedTools.length;
  return (
    <section className="col-span-3 rounded-lg border bg-card p-4 shadow-sm" aria-label="AI investigation">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">AI investigation</h2>
            <ProvenanceLabel>Advisory only · verdict already sealed</ProvenanceLabel>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Model: <span className="font-mono text-foreground">{modelId ?? "none"}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium">Authority boundary</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            sealed verdict {detail.verdictHash ? detail.verdictHash.slice(0, 12) : "not available"}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="min-w-0 rounded-md border p-3">
          <p className="text-xs font-semibold uppercase text-muted-foreground">1 · Plan</p>
          <p className="mt-2 text-sm font-semibold">Selected {selectedCount} of 2 available tool slots</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {planPresentation({
              source: detail.plan.source,
              selectedTools: detail.plan.selectedTools,
              runtimeReason: detail.plan.runtimeReason,
            })}
          </p>
          <div className="mt-3">
            <PlanAlternatives
              considered={detail.planConsidered}
              source={detail.plan.source}
              selectedTools={detail.plan.selectedTools}
            />
          </div>
        </section>

        <section className="min-w-0 rounded-md border p-3">
          <p className="text-xs font-semibold uppercase text-muted-foreground">2 · Gather</p>
          {detail.externalContext ? (
            <div className="mt-2">
              <div className="flex items-center gap-2 text-sm font-semibold"><CloudRain className="size-4" />Weather context</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail.externalContext.summary}</p>
            </div>
          ) : (
            <p className="mt-2 text-xs leading-5 text-muted-foreground">Weather lookup was not selected.</p>
          )}
          {detail.toolResults.map((result) => (
            <div key={result.tool} className="mt-3 border-t pt-3">
              <p className="font-mono text-xs font-semibold">{result.tool}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{result.summary}</p>
            </div>
          ))}
          <div className="mt-3 rounded-md bg-muted/60 px-3 py-2 text-xs">
            <span className="font-semibold">Impact on verdict</span>
            <span className="ml-2 text-muted-foreground">None · context is explanatory only</span>
          </div>
        </section>

        <section className="min-w-0 rounded-md border p-3">
          <p className="text-xs font-semibold uppercase text-muted-foreground">3 · Explain</p>
          <div className="mt-2 inline-flex rounded-md border bg-muted/40 p-1">
            <button
              type="button"
              className={cn("rounded px-2.5 py-1.5 text-xs font-medium", tab === "model" && "bg-background shadow-sm")}
              onClick={() => onTabChange("model")}
            >
              Model explanation
            </button>
            <button
              type="button"
              className={cn("rounded px-2.5 py-1.5 text-xs font-medium", tab === "fallback" && "bg-background shadow-sm")}
              onClick={() => onTabChange("fallback")}
            >
              Without model
            </button>
          </div>

          {tab === "model" ? (
            <div className="mt-3">
              <p className="text-sm leading-6">{detail.explanation.text ?? "No model explanation was produced."}</p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {detail.explanation.source === "model"
                  ? `Grounded prose from ${detail.explanation.modelId ?? "the configured model"}.`
                  : detail.explanation.rejection ?? detail.explanation.runtimeReason ?? "Structured fallback used."}
              </p>
              {detail.explanation.citations.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Explanation citations">
                  {detail.explanation.citations.map((citation) => {
                    const target = citationTarget(citation);
                    return (
                      <a
                        key={citation}
                        href={target.href}
                        onClick={() => target.evidenceId && onEvidenceSelect(target.evidenceId)}
                        className="rounded border bg-muted px-2 py-1 font-mono text-xs hover:bg-accent"
                      >
                        {citation}
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-y-2 text-xs">
              <dt className="text-muted-foreground">Decision</dt><dd className="font-mono">{detail.gate.decision ?? "none"}</dd>
              <dt className="text-muted-foreground">Single-event</dt><dd className="font-mono">{detail.summary.inconsistency.score ?? "not evaluated"}</dd>
              <dt className="text-muted-foreground">Pattern</dt><dd className="font-mono">{detail.summary.pattern.score ?? "not evaluated"}</dd>
              <dt className="text-muted-foreground">Flags</dt><dd className="font-mono">{detail.flags.map((flag) => flag.id).join(", ") || "none"}</dd>
              <dt className="text-muted-foreground">Missing evidence</dt>
              <dd>{detail.locationEvidence ? "I1 reference sites" : "none recorded"}</dd>
            </dl>
          )}

          <p className="mt-3 border-t pt-3 text-xs leading-5 text-muted-foreground">
            Both views read the same sealed verdict hash. Model removal changes the prose, not the decision.
          </p>
        </section>
      </div>
    </section>
  );
}

function AttemptHistory({ runs, authoritativeRun }: { runs: HandoffDetail["runs"]; authoritativeRun: number }) {
  return (
    <section className="col-span-2 rounded-md bg-card p-4 shadow-sm">
      <h2 className="text-sm font-semibold">Attempt history</h2>
      <ol className="mt-3 divide-y rounded-md border px-3">
        {runs.map((run) => {
          const label = attemptHistoryLabel(run);
          return (
            <li key={run.run} className="flex gap-3 py-3 text-xs">
              <span className="font-mono text-muted-foreground">#{run.run}</span>
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{label.title}</span>
                <span className="mt-0.5 block leading-5 text-muted-foreground">{label.detail}</span>
              </span>
              {run.run === authoritativeRun && <ProvenanceLabel>displayed result</ProvenanceLabel>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function CredentialHalf({
  label,
  value,
  valid,
  neutral = false,
}: {
  label: string;
  value: string;
  valid: boolean;
  neutral?: boolean;
}) {
  return (
    <div className={cn(
      "rounded-md border px-3 py-2.5",
      valid
        ? "border-emerald-300 bg-emerald-50"
        : neutral
          ? "border-border bg-muted/40"
          : "border-amber-300 bg-amber-50",
    )}>
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <KeyRoundIcon valid={valid} neutral={neutral} />
        {label}
      </div>
      <div className={cn(
        "mt-1 font-mono text-xs font-semibold",
        valid ? "text-emerald-700" : neutral ? "text-muted-foreground" : "text-amber-700",
      )}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {neutral ? "mandate did not require this half" : "binds event + nonce"}
      </div>
    </div>
  );
}

function KeyRoundIcon({ valid, neutral = false }: { valid: boolean; neutral?: boolean }) {
  return <span aria-hidden="true" className={cn(
    "size-2 rounded-full",
    valid ? "bg-emerald-600" : neutral ? "border border-muted-foreground" : "border border-amber-600",
  )} />;
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

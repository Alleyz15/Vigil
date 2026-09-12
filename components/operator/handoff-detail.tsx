"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, CircleDashed, CloudRain, KeyRound, Link2, Pause, Play, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { HandoffDetail } from "@/lib/workbench";
import { formatEvidenceValue } from "@/lib/display/evidence";
import { cn } from "@/lib/utils";
import { AxisPair } from "./axis-pair";
import { detailStatusMessage, traceNodeStates } from "./handoff-detail-model";
import { OperatorActions } from "./operator-actions";
import { ProvenanceLabel } from "./provenance-label";
import { PlanAlternatives, RerouteAlternatives } from "./rejected-alternatives";
import { ShipmentMap } from "./shipment-map";
import { HandoffStateBadge } from "./status-badge";
import { StreamView } from "@/components/console/stream-view";

function sentence(value: string | null): string {
  return value?.replaceAll("_", " ") ?? "Unavailable";
}

export function HandoffDetailView({ detail }: { detail: HandoffDetail }) {
  const [activeLegIndex, setActiveLegIndex] = useState(detail.summary.legIndex);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const status = detailStatusMessage(detail.summary);
  const latestRun = detail.runs.at(-1);
  const trace = useMemo(() => traceNodeStates(latestRun?.trace ?? []), [latestRun?.trace]);
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

  useEffect(() => {
    if (!playing) return;
    const currentPosition = detail.timeline.findIndex((leg) => leg.legIndex === activeLegIndex);
    const timer = setTimeout(() => {
      const next = detail.timeline[currentPosition + 1];
      if (!next) {
        setPlaying(false);
        return;
      }
      setActiveLegIndex(next.legIndex);
      if (currentPosition + 1 === detail.timeline.length - 1) setPlaying(false);
    }, 1900);
    return () => clearTimeout(timer);
  }, [activeLegIndex, detail.timeline, playing]);

  return (
    <div>
      <header className="mb-4">
        <Button nativeButton={false} variant="ghost" size="sm" render={<Link href="/operator/inbox" />}>
          <ArrowLeft data-icon="inline-start" />
          Back to inbox
        </Button>
        <div className="mt-3 flex items-end justify-between gap-8">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{detail.summary.parcel.waybillNo}</h1>
              <HandoffStateBadge state={detail.summary.state} />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {detail.summary.courier.displayName} · {detail.summary.bizStep} · seeded synthetic shipment {detail.summary.scenarioId}
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs font-semibold uppercase text-muted-foreground">Correlation ID</div>
            <div className="mt-1 max-w-md break-all font-mono text-xs">{detail.summary.eventId}</div>
          </div>
        </div>
      </header>

      <section
        className={cn(
          "mb-4 flex items-start gap-3 rounded-md border px-4 py-3",
          status.tone === "pending" && "border-amber-300 bg-amber-50 text-amber-950",
          status.tone === "alert" && "border-red-200 bg-red-50 text-red-950",
          status.tone === "accepted" && "border-emerald-200 bg-emerald-50 text-emerald-950",
          status.tone === "resolved" && "bg-card",
        )}
      >
        {detail.summary.sealed ? <CheckCircle2 className="mt-0.5 size-5 shrink-0" /> : <CircleDashed className="mt-0.5 size-5 shrink-0" />}
        <div>
          <h2 className="text-sm font-semibold">{status.title}</h2>
          <p className="mt-0.5 text-xs leading-5 opacity-80">{status.detail}</p>
        </div>
      </section>

      <div className="grid grid-cols-[minmax(0,1.7fr)_23rem] gap-4">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Route and contradiction evidence</h2>
            <ProvenanceLabel>OpenStreetMap · synthetic event coordinates</ProvenanceLabel>
          </div>
          <ShipmentMap
            model={detail.map}
            activeLegIndex={activeLegIndex}
            revealOverlays={revealOverlays}
            selectedEvidenceId={selectedEvidenceId}
            onSelectEvidence={setSelectedEvidenceId}
          />

          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (!playing && activeLegIndex === detail.timeline.at(-1)?.legIndex) {
                  setActiveLegIndex(detail.timeline[0].legIndex);
                }
                setPlaying((value) => !value);
              }}
            >
              {playing ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
              {playing ? "Pause route" : "Play route"}
            </Button>
            <span className="text-xs text-muted-foreground">1.9 seconds per leg · contradiction appears at the reviewed handoff</span>
          </div>
          <ol className="mt-2 flex gap-1 overflow-x-auto pb-2" aria-label="Shipment legs">
            {detail.timeline.map((leg) => (
              <li key={leg.eventId} className="w-36 shrink-0">
                <button
                  type="button"
                  onClick={() => setActiveLegIndex(leg.legIndex)}
                  className={cn(
                    "w-full rounded-md border px-2 py-2 text-left transition-colors",
                    leg.legIndex === activeLegIndex ? "border-primary bg-accent" : "bg-card hover:bg-muted",
                  )}
                >
                  <span className="block text-xs font-semibold uppercase text-muted-foreground">Leg {leg.legIndex + 1}</span>
                  <span className="mt-0.5 block truncate text-xs font-medium capitalize">{leg.bizStep}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>

        <aside className="self-start rounded-md border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Decision and action</h2>
            <ProvenanceLabel>{detail.summary.sealed ? "sealed" : "pending"}</ProvenanceLabel>
          </div>

          <div className="mt-4 border-y py-4">
            <AxisPair inconsistency={detail.summary.inconsistency} pattern={detail.summary.pattern} />
            <p className="mt-2 text-xs text-muted-foreground">{detail.summary.coverageLine ?? "Evidence coverage unavailable"}</p>
          </div>

          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 py-4 text-xs">
            <dt className="text-muted-foreground">Engine verdict</dt>
            <dd className="font-semibold capitalize">{sentence(detail.gate.decision)}</dd>
            <dt className="text-muted-foreground">Gate basis</dt>
            <dd className="font-medium">{sentence(detail.summary.gateBasis)}</dd>
            <dt className="text-muted-foreground">Operator state</dt>
            <dd className="font-medium">{sentence(detail.summary.state)}</dd>
          </dl>

          <OperatorActions
            eventId={detail.summary.eventId}
            state={detail.summary.state}
            rerouteAvailable={rerouteAvailable}
            rerouteReason={rerouteReason}
          />

          <div className="mt-4 border-t pt-4">
            <div className="flex items-center gap-2 text-xs font-semibold"><KeyRound className="size-4" /> Credential</div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Courier signature {detail.credential?.courierValid ? "valid" : "missing"}. Operator signature {detail.credential?.operatorValid ? "valid" : "missing"}.
            </p>
          </div>
        </aside>
      </div>

      <div className="mt-8 grid grid-cols-[minmax(0,1.25fr)_minmax(22rem,0.75fr)] gap-8">
        <section>
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Evidence behind the decision</h2>
            <span className="text-xs text-muted-foreground">Select a coordinate-bearing flag to focus the map</span>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {detail.flags.length === 0 ? (
              <div className="border-y px-2 py-4 text-sm text-muted-foreground">No contradiction flags were raised.</div>
            ) : detail.flags.map((flag) => (
              <button
                key={flag.id}
                type="button"
                onClick={() => setSelectedEvidenceId(flag.id)}
                className={cn(
                  "w-full rounded-md border bg-card px-4 py-3 text-left transition-colors",
                  selectedEvidenceId === flag.id ? "border-primary ring-2 ring-primary/15" : "hover:bg-muted",
                )}
              >
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
              </button>
            ))}
          </div>

          <section className="mt-8">
            <h2 className="text-base font-semibold">Eight-node run</h2>
            <p className="mt-1 text-xs text-muted-foreground">Frozen trace contract. State changes below are execution timing, not decorative animation.</p>
            <ol className="mt-3 grid grid-cols-4 gap-2">
              {trace.map((node) => (
                <li key={node.node} className="rounded-md border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold">{node.node}</span>
                    <Badge variant="outline" className="text-xs">{node.status}</Badge>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    {node.durationMs === null ? "not reached" : `${node.durationMs} ms`}
                    {node.flags.length > 0 && ` · ${node.flags.join(", ")}`}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </section>

        <div className="flex flex-col gap-4">
          <section className="rounded-md border bg-card p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Agent explanation</h2>
              <ProvenanceLabel>{detail.explanation.source}</ProvenanceLabel>
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{detail.explanation.text ?? "No explanation was produced."}</p>
          </section>

          <section className="rounded-md border bg-card p-4">
            <div className="flex items-center gap-2"><CloudRain className="size-4" /><h2 className="text-sm font-semibold">External context</h2></div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {detail.externalContext?.summary ?? "Weather was not selected for this run."}
            </p>
            {detail.externalContext?.status === "available" && (
              <p className="mt-2 text-xs leading-4 text-muted-foreground">Open-Meteo archive · approximately 9 km reanalysis · regional context, not an observation at the address.</p>
            )}
          </section>

          <section className="rounded-md border bg-card p-4">
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
          <section className="rounded-md border bg-card p-4">
            <PlanAlternatives
              considered={detail.planConsidered}
              source={detail.plan.source}
              selectedTools={detail.plan.selectedTools}
            />
          </section>

          <section className="rounded-md border bg-card p-4">
            <div className="flex items-center gap-2"><Link2 className="size-4" /><h2 className="text-sm font-semibold">Seal and ledger</h2></div>
            <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-y-2 text-xs">
              <dt className="text-muted-foreground">Ledger sequence</dt><dd className="font-mono">{detail.ledger.sequence ?? "not written"}</dd>
              <dt className="text-muted-foreground">Chain</dt><dd className="font-medium">{detail.ledger.chainValid ? `intact across ${detail.ledger.entries} records` : "broken"}</dd>
              <dt className="text-muted-foreground">Pipeline runs</dt><dd className="font-mono">{detail.runs.length}</dd>
            </dl>
          </section>
        </div>
      </div>

      <details className="mt-8 rounded-md border bg-card px-4 py-3">
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

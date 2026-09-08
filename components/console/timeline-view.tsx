"use client";

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  initialPlayback,
  playbackReducer,
  shouldTick,
  tickIntervalMs,
} from "@/lib/console/playback";
import type { LegView, ScenarioView } from "@/lib/console/dataset";
import { AxisScores } from "./axis-scores";
import { VerdictBadge, verdictKindFor } from "./verdict-badge";

/**
 * View 1: a whole shipment, leg by leg.
 *
 * This is how the brief's "from normal activity to a meaningful exception" is
 * demonstrated. The play control exists because a viewer who is shown the end
 * state has been told the answer; one who watches five ordinary legs and then
 * the sixth has seen the system do something.
 *
 * Motion is used for leg entrance and the expand transition, which is one of
 * the three places it is allowed. Radix (Collapsible) keeps its own data-state
 * animation and is never wrapped in AnimatePresence — the two unmount
 * mechanisms fight. See CLAUDE.md.
 */

const STEP_LABEL: Record<string, string> = {
  "urn:epcglobal:cbv:bizstep:receiving": "Collection",
  "urn:epcglobal:cbv:bizstep:storing": "Sortation",
  "urn:epcglobal:cbv:bizstep:departing": "Line-haul departure",
  "urn:epcglobal:cbv:bizstep:arriving": "Line-haul arrival",
  "urn:epcglobal:cbv:bizstep:transporting": "Out for delivery",
  "urn:epcglobal:cbv:bizstep:delivering": "Delivery",
  "urn:epcglobal:cbv:bizstep:accepting": "Accepted by recipient",
};

const stepLabel = (bizStep: string | null) =>
  (bizStep && STEP_LABEL[bizStep]) ?? bizStep?.split(":").pop() ?? "—";

const timeLabel = (iso: string) =>
  iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "—";

export function TimelineView({ scenario }: { scenario: ScenarioView }) {
  const [state, dispatch] = useReducer(playbackReducer, initialPlayback(scenario.legCount));
  const [expanded, setExpanded] = useState<number | null>(null);

  // Switching scenarios remounts this component (the page keys it on the
  // scenario id), so playback starts fresh without an effect resetting state.

  // The component owns the interval; the reducer owns what a tick means.
  useEffect(() => {
    if (!shouldTick(state)) return;
    const timer = setTimeout(
      () => dispatch({ type: "tick" }),
      tickIntervalMs(state, scenario.exceptionLegIndex),
    );
    return () => clearTimeout(timer);
  }, [state, scenario.exceptionLegIndex]);

  const visible = useMemo(() => scenario.legs.slice(0, state.revealed), [scenario.legs, state.revealed]);

  const jumpToException = useCallback(() => {
    if (scenario.exceptionLegIndex !== null) {
      dispatch({ type: "seek", index: scenario.exceptionLegIndex });
      setExpanded(scenario.exceptionLegIndex);
    }
  }, [scenario.exceptionLegIndex]);

  return (
    <div>
      <Controls
        state={state}
        scenario={scenario}
        onPlay={() => dispatch({ type: "play" })}
        onPause={() => dispatch({ type: "pause" })}
        onNext={() => dispatch({ type: "next" })}
        onPrev={() => dispatch({ type: "prev" })}
        onReset={() => dispatch({ type: "reset" })}
        onRevealAll={() => dispatch({ type: "revealAll" })}
        onException={jumpToException}
      />

      <ol className="mt-6 space-y-2">
        <AnimatePresence initial={false}>
          {visible.map((leg) => (
            <motion.li
              key={leg.eventId || leg.index}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              <LegRow
                leg={leg}
                isException={leg.index === scenario.exceptionLegIndex}
                isCursor={leg.index === state.cursor}
                open={expanded === leg.index}
                onOpenChange={(open) => setExpanded(open ? leg.index : null)}
              />
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>

      {state.revealed === 0 && (
        <div className="mt-6 rounded-lg border border-dashed border-border/60 px-5 py-8 text-center text-sm text-muted-foreground">
          Press play to watch this shipment leg by leg.
        </div>
      )}
    </div>
  );
}

function Controls({
  state,
  scenario,
  onPlay,
  onPause,
  onNext,
  onPrev,
  onReset,
  onRevealAll,
  onException,
}: {
  state: ReturnType<typeof initialPlayback>;
  scenario: ScenarioView;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onReset: () => void;
  onRevealAll: () => void;
  onException: () => void;
}) {
  const playing = state.status === "playing";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <Button size="sm" onClick={playing ? onPause : onPlay} className="w-20">
        {playing ? "Pause" : state.status === "done" ? "Replay" : "Play"}
      </Button>
      <Button size="sm" variant="outline" onClick={onPrev} disabled={(state.cursor ?? 0) <= 0}>
        Prev
      </Button>
      <Button size="sm" variant="outline" onClick={onNext} disabled={state.revealed >= state.legCount}>
        Next
      </Button>
      <Button size="sm" variant="ghost" onClick={onRevealAll}>
        Show all
      </Button>
      <Button size="sm" variant="ghost" onClick={onReset}>
        Reset
      </Button>

      {scenario.exceptionLegIndex !== null && (
        <Button size="sm" variant="ghost" onClick={onException} className="text-amber-300">
          Jump to exception
        </Button>
      )}

      <div className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
        {state.revealed} / {state.legCount} legs
      </div>
    </div>
  );
}

function LegRow({
  leg,
  isException,
  isCursor,
  open,
  onOpenChange,
}: {
  leg: LegView;
  isException: boolean;
  isCursor: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const kind = verdictKindFor(leg);
  const halted = leg.halted !== null;

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div
        className={cn(
          "rounded-lg border bg-card/40 transition-colors",
          // Distinct without being loud: a left rule and a slightly warmer
          // surface, not a red banner.
          isException ? "border-amber-500/40 bg-amber-500/[0.04]" : "border-border/60",
          isCursor && "ring-1 ring-inset ring-primary/40",
        )}
      >
        <CollapsibleTrigger className="flex w-full items-center gap-4 px-4 py-3 text-left">
          <div className="w-8 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {String(leg.index + 1).padStart(2, "0")}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium">{stepLabel(leg.bizStep)}</span>
              {isException && (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">
                  exception
                </span>
              )}
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              {timeLabel(leg.eventTime)}
            </div>
          </div>

          <AxisScores
            inconsistencyScore={leg.inconsistencyScore}
            patternScore={leg.patternScore}
            inconsistencyEvaluable={leg.inconsistencyEvaluable}
            patternEvaluable={leg.patternEvaluable}
            className="shrink-0"
          />

          <div className="w-44 shrink-0 text-right">
            <div className="text-[11px] text-muted-foreground">{leg.coverageLine ?? "—"}</div>
            {leg.neededCosign && !halted && (
              <div className="mt-0.5 text-[11px] text-sky-300">operator co-signed</div>
            )}
          </div>

          <div className="w-44 shrink-0 text-right">
            <VerdictBadge kind={kind} />
            {/* A halt is not a decision, and the difference has to be legible
                without expanding the leg. */}
            {halted && (
              <div className="mt-1 font-mono text-[10px] leading-tight text-zinc-400">
                nothing sealed
              </div>
            )}
            {!halted && leg.ledgerSeq !== null && (
              <div className="mt-1 font-mono text-[10px] leading-tight text-muted-foreground">
                ledger #{leg.ledgerSeq}
              </div>
            )}
          </div>
        </CollapsibleTrigger>

        {/* Radix animates this itself via data-state. Wrapping it in
            AnimatePresence would put two unmount mechanisms in a fight. */}
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <LegDetail leg={leg} />
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function LegDetail({ leg }: { leg: LegView }) {
  return (
    <div className="border-t border-border/60 px-4 py-4">
      {leg.halted && (
        <div className="mb-4 rounded-md border border-sky-500/30 bg-sky-500/[0.06] px-3 py-2">
          <div className="text-[12px] font-medium text-sky-300">
            Halted at <span className="font-mono">{leg.halted.at}</span> — {leg.halted.reason}
          </div>
          <div className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            {leg.halted.reason === "PENDING_COSIGNATURE"
              ? "No verdict was written. The courier's signature verified, but this handoff needs an operator co-signature and none was presented — so there is no valid credential to seal."
              : "The run stopped here and nothing was sealed."}
          </div>
        </div>
      )}

      {leg.requiresCosign && leg.cosignReasons.length > 0 && (
        <Section title="Why a co-signature is required">
          <ul className="space-y-1">
            {leg.cosignReasons.map((reason) => (
              <li key={reason} className="text-[12px] leading-relaxed text-muted-foreground">
                {reason}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Checks that fired (${leg.flags.length})`}>
        {leg.flags.length === 0 ? (
          <div className="text-[12px] text-muted-foreground">
            Nothing raised a concern on this leg.
          </div>
        ) : (
          <div className="space-y-2">
            {leg.flags.map((flag) => (
              <div key={`${flag.id}-${flag.label}`} className="rounded-md border border-border/50 px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[11px] text-amber-300">{flag.id}</span>
                  {flag.points > 0 && (
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      +{flag.points}
                    </span>
                  )}
                  <span className="text-[12px] leading-snug">{flag.label}</span>
                </div>

                {/* The evidence behind the decision, naming field AND value. */}
                {flag.evidence.length > 0 && (
                  <dl className="mt-2 grid grid-cols-[minmax(0,14rem)_1fr] gap-x-4 gap-y-1">
                    {flag.evidence.map((item) => (
                      <div key={item.field} className="contents">
                        <dt className="truncate font-mono text-[11px] text-muted-foreground">
                          {item.field}
                        </dt>
                        <dd className="break-all font-mono text-[11px] text-foreground/80">
                          {formatValue(item.value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {leg.explanation && (
        <Section title={leg.explanationFromFallback ? "Explanation (structured fallback)" : "Explanation"}>
          <p className="text-[12px] leading-relaxed text-muted-foreground">{leg.explanation}</p>
        </Section>
      )}

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[10px] text-muted-foreground">
        <span>event {leg.eventId.slice(0, 8)}</span>
        {leg.basis && <span>basis {leg.basis}</span>}
        {leg.matrixCell && <span>gate {leg.matrixCell}</span>}
        {leg.recordTime && <span>recorded {timeLabel(leg.recordTime)}</span>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

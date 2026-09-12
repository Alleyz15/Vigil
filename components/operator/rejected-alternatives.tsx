import { Check, Minus } from "lucide-react";
import type { RerouteOutcome } from "@/lib/reroute";
import type { ToolConsideration } from "@/lib/llm/plan";
import { ProvenanceLabel } from "./provenance-label";
import { cn } from "@/lib/utils";

/**
 * What the agent weighed and did not choose.
 *
 * An agent that shows only its output is asking to be trusted. One that shows
 * the option set and why each option lost can be checked, and that is the
 * difference between a demo and evidence.
 *
 * EVERY REASON HERE IS PRODUCED BY THE SELECTOR — `considerTools` in
 * lib/llm/plan.ts and `proposeReroute` in lib/reroute/propose.ts. Nothing on
 * this page works out "why not that one?" for itself. Re-deriving it would be a
 * second implementation of the eligibility rules, drifting from the real one
 * the moment a mandate rule moved, in exactly the way a browser recomputing a
 * verdict would drift from the sealed one.
 */

function Row({
  selected,
  title,
  reason,
  meta,
}: {
  selected: boolean;
  title: string;
  reason: string;
  meta?: string;
}) {
  return (
    <li className="flex items-start gap-3 py-2">
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
          selected ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground",
        )}
      >
        {selected ? <Check aria-hidden="true" className="size-3" /> : <Minus aria-hidden="true" className="size-3" />}
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className={cn("font-mono text-xs", selected ? "font-semibold" : "text-muted-foreground")}>
            {title}
          </span>
          {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
        </span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{reason}</span>
      </span>
    </li>
  );
}

export function PlanAlternatives({
  considered,
  source,
  selectedTools,
}: {
  considered: ToolConsideration[];
  source: "model" | "heuristic" | "unavailable";
  selectedTools: string[];
}) {
  /**
   * When a model chose the tools, the deterministic set is shown alongside as
   * a comparison rather than as the reason. Presenting the heuristic's reasons
   * as though they explained the model's pick would be inventing a rationale
   * nobody produced — the model is not asked to justify itself, and rule 1b's
   * whole point is that its choice cannot move the verdict either way.
   */
  const modelChose = source === "model";

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Context tools considered</h3>
        <ProvenanceLabel>{modelChose ? "selected by the model" : "deterministic heuristic"}</ProvenanceLabel>
      </div>

      {modelChose && (
        <p className="mb-2 text-xs leading-5 text-muted-foreground">
          The model selected{" "}
          <span className="font-mono">{selectedTools.join(", ") || "no tools"}</span>. The rows below
          are what the deterministic heuristic would have chosen and why — shown for comparison, not
          as the model&rsquo;s reasoning. Either way the verdict is identical.
        </p>
      )}

      <ul className="divide-y rounded-md border px-3">
        {considered.map((entry) => (
          <Row key={entry.tool} selected={entry.selected} title={entry.tool} reason={entry.reason} />
        ))}
      </ul>
    </section>
  );
}

export function RerouteAlternatives({ reroute }: { reroute: RerouteOutcome | null }) {
  if (!reroute) return null;

  const considered = reroute.considered ?? [];
  const proposed = reroute.status === "proposed";

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Reroute destinations considered</h3>
        {/*
          THE UNEXERCISED PATH, LABELLED. No seeded scenario currently yields a
          reroute proposal, so the success branch has never run end to end. The
          provenance vocabulary says so rather than letting a viewer assume the
          panel is only showing rejections because rejections are all there
          were. Same discipline as "Open-Meteo not wired yet" in the stream view.
        */}
        {!proposed && (
          <ProvenanceLabel>proposal path unexercised by the current dataset</ProvenanceLabel>
        )}
      </div>

      <p className="mb-2 text-xs leading-5 text-muted-foreground">
        {reroute.status === "proposed"
          ? "One destination was authorised. The others are shown with the rule that excluded them."
          : reroute.reason}
      </p>

      {considered.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">
          No destinations were weighed — this handoff was accepted, so no reroute was sought.
        </p>
      ) : (
        <ul className="divide-y rounded-md border px-3">
          {considered.map((candidate) => (
            <Row
              key={`${candidate.kind}-${candidate.id}`}
              selected={candidate.selected}
              title={candidate.label}
              reason={candidate.reason}
              meta={
                candidate.kind === "courier_reassignment"
                  ? "alternate courier"
                  : candidate.distanceMeters !== undefined
                    ? `${candidate.distanceMeters} m away`
                    : "pickup point"
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

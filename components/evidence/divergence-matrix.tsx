"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import type { DivergenceReport } from "@/lib/evidence/e4";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import { cn } from "@/lib/utils";

/**
 * E4a, on screen: the models disagree with each other; the engine does not.
 *
 * THE VISUAL ARGUMENT IS THE CONTRAST BETWEEN THE BLOCKS. Three model rows with
 * different colours across them, a separator, then one engine row that is the
 * same answer for everybody. A reader should get that before reading a word.
 *
 * Both halves of the finding are shown, because either alone misleads. Every
 * cell carries its `5/5` — each model was perfectly consistent WITH ITSELF.
 * "Models are unreliable" is not the claim and would be refuted by that column;
 * the claim is that **which model you ask changes the answer**, which no amount
 * of per-vendor stability fixes.
 */

const DECISION_TONE: Record<string, string> = {
  accept: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/30",
  flag: "bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/30",
  escalate: "bg-orange-500/15 text-orange-800 dark:text-orange-300 border-orange-500/30",
  freeze: "bg-red-500/15 text-red-800 dark:text-red-300 border-red-500/30",
};

export function DivergenceMatrix({ report }: { report: DivergenceReport }) {
  const [open, setOpen] = useState<string | null>(null);
  const providers = [...new Set(report.cells.map((c) => c.provider))];

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ProvenanceLabel>measured {report.measuredOn}</ProvenanceLabel>
        <ProvenanceLabel>{report.samplesPerCell} calls per cell</ProvenanceLabel>
        <ProvenanceLabel>read from results/e4a-cross-vendor.csv · no model called to render</ProvenanceLabel>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[46rem] border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th scope="col" className="px-4 py-3 text-left font-semibold">Who decided</th>
              {report.scenarios.map((s) => (
                <th key={s.scenario} scope="col" className="px-4 py-3 text-left font-semibold">
                  <span className="font-mono">{s.scenario}</span>
                  <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                    {s.meaning}
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {providers.map((provider) => (
              <tr key={provider} className="border-b">
                <th scope="row" className="px-4 py-3 text-left align-top">
                  <span className="block text-sm font-medium">{provider}</span>
                  <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                    {report.cells.find((c) => c.provider === provider)?.model}
                  </span>
                </th>

                {report.scenarios.map((s) => {
                  const cell = report.cells.find(
                    (c) => c.provider === provider && c.scenario === s.scenario,
                  );
                  if (!cell) return <td key={s.scenario} className="px-4 py-3" />;
                  const id = `${provider}-${s.scenario}`;

                  return (
                    <td key={s.scenario} className="px-4 py-3 align-top">
                      <button
                        type="button"
                        onClick={() => setOpen(open === id ? null : id)}
                        aria-expanded={open === id}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors",
                          DECISION_TONE[cell.decision] ?? "border-muted bg-muted/40",
                          // The divergent cells must be findable without reading.
                          cell.divergesFromEngine && "ring-2 ring-red-500/60",
                        )}
                      >
                        <span className="flex-1">
                          <span className="block font-mono text-sm font-semibold">{cell.decision}</span>
                          <span className="block text-[11px] opacity-80">
                            {cell.agreed}/{cell.samples} consistent
                          </span>
                        </span>
                        {cell.divergesFromEngine && (
                          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
                        )}
                        <ChevronDown
                          aria-hidden="true"
                          className={cn("size-3.5 shrink-0 opacity-60 transition-transform", open === id && "rotate-180")}
                        />
                      </button>

                      {cell.divergesFromEngine && (
                        <p className="mt-1.5 text-[11px] font-medium text-red-700 dark:text-red-400">
                          Differs from the engine, which said{" "}
                          <span className="font-mono">{cell.engineDecision}</span>
                        </p>
                      )}

                      {open === id && (
                        <div className="mt-2 rounded-md border bg-background p-2.5">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            What the model actually returned
                          </div>
                          <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
                            {cell.rawResponse}
                          </pre>
                          {!cell.reasoningOffered && (
                            <p className="mt-2 border-t pt-2 text-[11px] leading-5 text-muted-foreground">
                              <strong>No reasoning was offered.</strong> The deciding prompt asked
                              for a decision and this model volunteered nothing else. The bare
                              response is the disclosure: there is no argument here to check,
                              agree with, or refute.
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}

            {/* The separator carries the argument: everything above is a model. */}
            <tr>
              <td colSpan={report.scenarios.length + 1} className="bg-muted/60 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                and the deterministic engine, on the same events
              </td>
            </tr>

            <tr className="border-t-2 border-foreground/20 bg-primary/5">
              <th scope="row" className="px-4 py-3 text-left align-top">
                <span className="block text-sm font-semibold">Vigil</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  deterministic engine
                </span>
              </th>
              {report.scenarios.map((s) => (
                <td key={s.scenario} className="px-4 py-3 align-top">
                  <div className={cn("rounded-md border px-2.5 py-2", DECISION_TONE[s.engineDecision])}>
                    <span className="block font-mono text-sm font-semibold">{s.engineDecision}</span>
                    <span className="block text-[11px] opacity-80">same answer every run</span>
                  </div>
                </td>
              ))}
            </tr>

            <tr className="border-t bg-muted/20">
              <th scope="row" className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                Pairwise agreement between vendors
              </th>
              {report.scenarios.map((s) => (
                <td key={s.scenario} className="px-4 py-2.5">
                  <span
                    className={cn(
                      "font-mono text-sm font-semibold",
                      s.pairwiseAgreement < 1 && "text-red-700 dark:text-red-400",
                    )}
                  >
                    {(s.pairwiseAgreement * 100).toFixed(1)}%
                  </span>
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    {s.distinctDecisions} distinct {s.distinctDecisions === 1 ? "answer" : "answers"}
                  </span>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        <strong className="text-foreground">Every model was perfectly consistent with itself</strong>{" "}
        — {report.samplesPerCell}/{report.samplesPerCell} in every cell. That is half the finding
        and it is shown deliberately: the claim is not that models are erratic. The claim is that{" "}
        <strong className="text-foreground">which model you ask changes the answer</strong>, and no
        amount of per-vendor stability fixes that. The engine gives all three the same answer
        because it is not asking anyone.
      </p>
    </section>
  );
}

"use client";

import { useState } from "react";
import { AlertTriangle, ShieldOff } from "lucide-react";
import type { InjectionReport } from "@/lib/evidence/e4";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import { cn } from "@/lib/utils";
import { formatEvidenceValue } from "@/lib/display/evidence";
import { filterInjectionFields, injectionMovementLabel } from "./injection-field-model";

/**
 * E4c, rendered honestly — including the part that corrects an earlier reading.
 *
 * TWO WAYS TO GET THIS WRONG, both avoided here:
 *
 *  - Overstating: "injection flips models to accept". Two of three never
 *    reached `accept` at all; their decisions moved toward lower severity while
 *    remaining refusals.
 *  - Understating: "qwen's distribution did not shift, so qwen was unaffected".
 *    Its rows moved in BOTH directions and netted to zero. One refusal became
 *    an acceptance.
 *
 * The aggregate and the row level are therefore both shown. Session 14 reported
 * the aggregate correctly; the row-level movement was not surfaced, and reading
 * only the distribution leads to the opposite conclusion from the truth.
 */

const SEVERITY = ["accept", "flag", "escalate", "freeze"] as const;

const TONE: Record<string, string> = {
  accept: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  flag: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  escalate: "bg-orange-500/15 text-orange-800 dark:text-orange-300",
  freeze: "bg-red-500/15 text-red-800 dark:text-red-300",
};

export function InjectionPanel({ report }: { report: InjectionReport }) {
  const [surface, setSurface] = useState<string | null>(null);
  const selected = filterInjectionFields(report, surface);
  const reached = report.reachedAccept;
  const stats = [
    { id: "total", value: String(report.total), label: "rows total", detail: `${report.payloads.length} payloads × ${report.perProvider.length} models` },
    { id: "events", value: `${report.engineEventUnchanged}/${report.total}`, label: "engine events unchanged", detail: "byte-identical engine inputs" },
    { id: "verdicts", value: `${report.engineVerdictUnchanged}/${report.total}`, label: "verdict unchanged", detail: `engine stayed ${report.engineDecision}` },
    { id: "exposure", value: `${report.productionExplainExposure}/${report.total}`, label: "production exposure", detail: "prompt excludes untrusted fields" },
    { id: "steered", value: `${report.explainSteered}/${report.total}`, label: "explain steered", detail: "guard not exercised in this run" },
  ];

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ProvenanceLabel>measured {report.measuredOn}</ProvenanceLabel>
        <ProvenanceLabel>
          {report.payloads.length} payloads × {report.perProvider.length} models on{" "}
          <span className="font-mono">{report.scenario}</span>
        </ProvenanceLabel>
        <ProvenanceLabel>read from results/e4c-adversarial-robustness.csv</ProvenanceLabel>
        <ProvenanceLabel>engine verdict {report.engineDecision} throughout</ProvenanceLabel>
        <ProvenanceLabel>Full experiment · {report.total} rows</ProvenanceLabel>
      </div>

      <div className="injection-pair">
      {/* THE HEADLINE, stated at row level rather than aggregate. */}
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <h3 className="text-sm font-semibold">
          No hosted model reached <span className="font-mono">accept</span>. One local-model row did.
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Gemini and Claude moved toward lower severity under injection while staying refusals —
          nothing they returned would have released a parcel. {reached.length === 1 ? "One row" : `${reached.length} rows`}{" "}
          crossed the line, and it was the local model:
        </p>

        {reached.map((row) => (
          <p key={`${row.provider}-${row.payloadId}`} className="mt-2 font-mono text-xs">
            {row.model} · {row.surface} ·{" "}
            <span className="rounded px-1 py-0.5 text-amber-900 dark:text-amber-200">
              {row.cleanDecision} → {row.injectedDecision}
            </span>
          </p>
        ))}
      </div>

      {/* THE COUNTERINTUITIVE HALF, given its own weight. */}
      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm font-semibold">
          An aggregate that cancels out is not the same as nothing happening.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          The local model&rsquo;s decisions moved in both directions and netted to zero, so its
          totals are identical before and after. Reading only the distribution gives the opposite
          conclusion from the truth: it was the one model an injection actually moved across the
          accept boundary. The earlier reading of this experiment was incomplete rather than
          wrong — the aggregate was reported correctly and the row-level movement was not
          surfaced.
        </p>
      </div>
      </div>

      <dl className="injection-stats">
        {stats.map((stat) => (
          <div key={stat.id} className="min-w-0 rounded-lg border bg-card p-4">
            <dd className="font-mono text-xl font-semibold">
              <span data-injection-stat={stat.id}>{formatEvidenceValue(stat.value)}</span>
            </dd>
            <dt className="mt-2 text-xs font-semibold">{stat.label}</dt>
            <dd className="mt-1 text-xs leading-5 text-muted-foreground">{stat.detail}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 overflow-x-auto rounded-lg border bg-card">
        <div className="p-4">
          <h2 className="text-sm font-semibold">Model movement under injection</h2>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Decision distributions are shown alongside row movement so cancellation cannot hide a crossed boundary.
          </p>
        </div>
        <table className="w-full min-w-[60rem] table-fixed border-collapse text-sm">
          <colgroup>
            <col style={{ width: "24%" }} />
            <col style={{ width: "23%" }} />
            <col style={{ width: "23%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "12%" }} />
          </colgroup>
          <thead>
            <tr className="border-b bg-muted/40">
              <th scope="col" className="px-4 py-3 text-left font-semibold">Model</th>
              <th scope="col" className="px-4 py-3 text-left font-semibold">Clean evidence</th>
              <th scope="col" className="px-4 py-3 text-left font-semibold">Injected evidence</th>
              <th scope="col" className="px-4 py-3 text-left font-semibold">Aggregate</th>
              <th scope="col" className="px-4 py-3 text-left font-semibold">Rows moved</th>
            </tr>
          </thead>
          <tbody>
            {report.perProvider.map((row) => (
              <tr key={row.provider} className="border-b">
                <th scope="row" className="px-4 py-3 text-left align-top">
                  <span className="block text-sm font-medium">{row.provider}</span>
                  <span className="mt-0.5 block break-words font-mono text-xs text-muted-foreground">
                    {row.model}
                  </span>
                </th>
                <td className="px-4 py-3 align-top"><Distribution counts={row.clean} /></td>
                <td className="px-4 py-3 align-top"><Distribution counts={row.injected} /></td>
                <td className="px-4 py-3 align-top text-xs">
                  {row.distributionShifted ? (
                    <span className="font-medium">shifted</span>
                  ) : (
                    <span className="font-medium text-amber-700 dark:text-amber-400">
                      unchanged — but {row.changed} of {row.samples} rows moved
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 align-top font-mono text-sm font-semibold" data-rows-moved={row.provider}>{row.changed}/{row.samples}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Field-level injection evidence</h2>
          <p className="mt-1 text-xs text-muted-foreground">{selected.payloads.length} {selected.payloads.length === 1 ? "payload" : "payloads"} · {selected.rows.length} measured rows</p>
        </div>
        <label className="text-xs text-muted-foreground">
          <span className="mb-1 block">Injection field</span>
          <select
            aria-label="Injection field"
            className="h-9 w-64 rounded-md border bg-card px-3 text-sm text-foreground"
            value={surface ?? ""}
            onChange={event => setSurface(event.target.value || null)}
          >
            <option value="">All fields</option>
            {[...new Set(report.payloads.map(payload => payload.surface))].map(field => (
              <option key={field} value={field}>{field}</option>
            ))}
          </select>
        </label>
      </div>
      <ul className="injection-pair mt-3">
        {selected.payloads.map((payload) => (
          <li key={payload.payloadId} className="min-w-0 rounded-md border bg-card p-4">
            <div className="font-mono text-xs text-muted-foreground">{payload.surface}</div>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">
              {payload.text}
            </pre>
          </li>
        ))}
      </ul>

      <div className="mt-4 overflow-x-auto rounded-lg border bg-card">
        <table aria-label="Field-level model results" className="w-full min-w-[60rem] table-fixed border-collapse text-sm">
          <colgroup>
            <col style={{ width: "22%" }} />
            <col style={{ width: "30%" }} />
            <col style={{ width: "15%" }} />
            <col style={{ width: "15%" }} />
            <col style={{ width: "18%" }} />
          </colgroup>
          <thead>
            <tr className="border-b bg-muted/40">
              {["Field", "Model", "Clean", "Injected", "Movement"].map(label => (
                <th key={label} scope="col" className="px-4 py-3 text-left text-xs font-semibold">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {selected.rows.map(row => {
              const movement = injectionMovementLabel(row);
              return (
                <tr key={`${row.provider}-${row.payloadId}`} className="border-b">
                  <th scope="row" className="break-words px-4 py-3 text-left font-mono text-xs font-normal">{row.surface}</th>
                  <td className="px-4 py-3">
                    <span className="block font-medium">{row.provider}</span>
                    <span className="mt-1 block break-words font-mono text-xs text-muted-foreground">{row.model}</span>
                  </td>
                  <td className="px-4 py-3"><span className={cn("rounded px-2 py-1 font-mono text-xs", TONE[row.cleanDecision])}>{row.cleanDecision}</span></td>
                  <td className="px-4 py-3"><span className={cn("rounded px-2 py-1 font-mono text-xs", TONE[row.injectedDecision])}>{row.injectedDecision}</span></td>
                  <td className={cn("px-4 py-3 text-xs font-medium", movement === "Reached accept" ? "text-red-700" : "text-muted-foreground")}>{movement}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {selected.rows.length === 0 && <p className="p-4 text-sm text-muted-foreground">No measured results for this field.</p>}
      </div>

      {/* THE FRAMING. Not a compliment to the engine. */}
      <div className="injection-pair mt-6">
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-start gap-3">
          <ShieldOff aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">
              The engine did not resist the injection. There was nothing to resist.
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Natural-language instructions have no input surface on the engine: it receives no
              delivery note, recipient name, filename or display address, and parses no prose. The
              clean and injected arms present <strong>byte-identical</strong> engine events, so
              identical verdicts are a property of construction rather than a defence that held.
            </p>
            <p className="mt-2 rounded-md bg-muted/50 p-3 text-xs leading-5">
              {report.requiredToReachEngine}
            </p>
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              engine event unchanged {report.engineEventUnchanged}/{report.total} · sealed verdict
              unchanged {report.engineVerdictUnchanged}/{report.total} · engine verdict{" "}
              {report.engineDecision} throughout
            </p>
          </div>
        </div>
      </div>

      {/* THE MOST MISREADABLE NUMBER IN THE PROJECT. */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">
              The citation guard blocked {report.guardBlocked} — because nothing steered, not because it held.
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              In the forced-exposure arm, {report.explainSteered}/{report.total} explanations were
              steered by the injected text, so the guard had nothing to reject and{" "}
              <strong>was never exercised</strong>. Reading &ldquo;0 blocked&rdquo; as a pass draws
              the opposite conclusion from the evidence. What the guard does when a contradiction
              arrives is proven by its scripted tests, not by this run.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              <strong className="text-foreground">
                Production exposure was {report.productionExplainExposure}/{report.total}.
              </strong>{" "}
              The production explain prompt does not carry those untrusted fields at all — forced
              exposure exists only inside the experiment.
            </p>
          </div>
        </div>
      </div>
      </div>
    </section>
  );
}

function Distribution({ counts }: { counts: Record<string, number> }) {
  const present = SEVERITY.filter((d) => counts[d]);
  return (
    <div className="flex flex-wrap gap-1">
      {present.map((decision) => (
        <span
          key={decision}
          className={cn("rounded px-2 py-0.5 font-mono text-xs font-medium", TONE[decision])}
        >
          {decision} ×{counts[decision]}
        </span>
      ))}
    </div>
  );
}

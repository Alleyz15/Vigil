"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileSearch,
  ShieldCheck,
} from "lucide-react";
import type { DivergenceCell, DivergenceReport } from "@/lib/evidence/e4";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import { cn } from "@/lib/utils";
import {
  countDivergentCells,
  disclosureId,
  pairwiseAgreementColumns,
} from "./divergence-matrix-model";

const DECISION_TONE: Record<string, string> = {
  accept: "border-emerald-300 bg-emerald-50 text-emerald-800",
  flag: "border-amber-300 bg-amber-50 text-amber-800",
  escalate: "border-orange-300 bg-orange-50 text-orange-800",
  freeze: "border-red-300 bg-red-50 text-red-800",
};

export function DivergenceMatrix({ report }: { report: DivergenceReport }) {
  const providers = [...new Set(report.cells.map((cell) => cell.provider))];
  const initial = report.cells.find(
    (cell) => cell.divergesFromEngine && !cell.reasoningOffered,
  ) ?? report.cells[0] ?? null;
  const [selectedId, setSelectedId] = useState(initial ? disclosureId(initial) : null);
  const selected = report.cells.find((cell) => disclosureId(cell) === selectedId) ?? null;
  const divergentCells = countDivergentCells(report.cells);
  const allStable = report.cells.every((cell) => cell.agreed === cell.samples);
  const agreementColumns = pairwiseAgreementColumns(report.scenarios);

  return (
    <section>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-xs text-muted-foreground">
          {report.cells
            .filter((cell, index, cells) => cells.findIndex((item) => item.provider === cell.provider) === index)
            .map((cell) => cell.model)
            .join(" · ")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ProvenanceLabel>measured {report.measuredOn}</ProvenanceLabel>
          <ProvenanceLabel>{report.samplesPerCell} calls per cell</ProvenanceLabel>
          <ProvenanceLabel>read from results/e4a-cross-vendor.csv</ProvenanceLabel>
          <ProvenanceLabel>no model called to render</ProvenanceLabel>
        </div>
      </div>

      <div className="mb-5 grid items-stretch gap-4 xl:grid-cols-3">
        <SummaryCard
          icon={CheckCircle2}
          title="Stable inside, divergent across"
          detail={allStable
            ? `Every model cell is ${report.samplesPerCell}/${report.samplesPerCell} consistent. The configured vendor can still change the verdict.`
            : "The measured cells include within-model variation; inspect the matrix below."}
        />
        <SummaryCard
          icon={AlertTriangle}
          title={`${divergentCells} ${divergentCells === 1 ? "cell differs" : "cells differ"} from the engine`}
          detail={report.cells
            .filter((cell) => cell.divergesFromEngine)
            .map((cell) => `${cell.provider} ${cell.scenario}: ${cell.decision}, engine ${cell.engineDecision}`)
            .join(". ")}
          tone="danger"
        />
        <SummaryCard
          icon={ShieldCheck}
          title="Engine row is the control"
          detail="Vigil gives the deterministic answer because it is not asking any model for a verdict."
          tone="success"
        />
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table
          data-column-layout="matrix"
          className="w-full min-w-[68rem] table-fixed border-collapse text-sm"
        >
          <MatrixColumnGroup scenarioCount={report.scenarios.length} />
          <thead>
            <tr className="border-b bg-muted/35">
              <th
                scope="col"
                className="w-64 py-4 text-left text-xs font-semibold text-muted-foreground"
                style={{ paddingLeft: 28, paddingRight: 20 }}
              >
                Who decided
              </th>
              {report.scenarios.map((scenario) => (
                <th key={scenario.scenario} scope="col" className="px-4 py-4 text-left align-top">
                  <span className="font-mono text-sm font-semibold">{scenario.scenario}</span>
                  <span className="mt-1 block max-w-52 text-xs font-normal leading-4 text-muted-foreground">
                    {scenario.meaning}
                  </span>
                </th>
              ))}
              <th scope="col" className="w-48 px-5 py-4 text-left text-xs font-semibold text-red-700">
                Divergent cells are ringed red
              </th>
            </tr>
          </thead>

          <tbody>
            {providers.map((provider) => (
              <tr key={provider} className="border-b">
                <ProviderCell provider={provider} cells={report.cells} />
                {report.scenarios.map((scenario) => {
                  const cell = report.cells.find(
                    (item) => item.provider === provider && item.scenario === scenario.scenario,
                  );
                  return cell ? (
                    <DecisionCell
                      key={scenario.scenario}
                      cell={cell}
                      selected={selectedId === disclosureId(cell)}
                      onSelect={() => setSelectedId(disclosureId(cell))}
                    />
                  ) : <td key={scenario.scenario} className="px-4 py-3" />;
                })}
                <td className="px-5 py-3 text-xs text-muted-foreground">
                  {report.cells.some((cell) => cell.provider === provider && cell.divergesFromEngine)
                    ? "Differs from control"
                    : "Matches control"}
                </td>
              </tr>
            ))}

            <tr>
              <td colSpan={report.scenarios.length + 2} className="bg-muted px-5 py-2 text-xs font-semibold uppercase text-muted-foreground">
                and the deterministic engine, on the same events
              </td>
            </tr>

            <tr>
              <th
                scope="row"
                className="py-4 text-left align-top"
                style={{ paddingLeft: 28, paddingRight: 20 }}
              >
                <span className="block text-sm font-semibold">Vigil</span>
                <span className="mt-1 block text-xs font-normal text-muted-foreground">deterministic engine</span>
              </th>
              {report.scenarios.map((scenario) => (
                <td key={scenario.scenario} className="px-4 py-3 align-top">
                  <div className={cn("rounded-md border px-3 py-2", DECISION_TONE[scenario.engineDecision])}>
                    <span className="block font-mono text-sm font-semibold">{scenario.engineDecision}</span>
                    <span className="mt-1 block text-xs opacity-80">same answer every run</span>
                  </div>
                </td>
              ))}
              <td className="px-5 py-3 text-xs font-medium text-emerald-700">Control</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-5 overflow-x-auto rounded-lg border bg-card">
        <table
          data-column-layout="pairwise"
          className="w-full min-w-[68rem] table-fixed border-collapse text-sm"
        >
          <MatrixColumnGroup scenarioCount={agreementColumns.length} />
          <tbody>
            <tr>
              <th
                scope="row"
                className="py-5 text-left text-xs font-medium leading-5 text-muted-foreground"
                style={{ paddingLeft: 28, paddingRight: 20 }}
              >
                Pairwise agreement between vendors
              </th>
            {agreementColumns.map((scenario) => (
              <td key={scenario.scenario} className="px-4 py-5 align-middle">
                <div className="font-mono text-xs font-semibold text-foreground">{scenario.scenario}</div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className={cn(
                    "font-mono text-lg font-semibold",
                    scenario.pairwiseAgreement < 1 ? "text-red-700" : "text-emerald-700",
                  )}>
                    {(scenario.pairwiseAgreement * 100).toFixed(1)}%
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {scenario.distinctDecisions} {scenario.distinctDecisions === 1 ? "answer" : "answers"}
                  </span>
                </div>
              </td>
            ))}
              <td aria-hidden="true" />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-5 grid items-start gap-4 xl:grid-cols-[1.1fr_1fr]">
        <section className="overflow-hidden rounded-lg bg-[#07111f] p-5 text-slate-200">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
            <FileSearch aria-hidden="true" className="size-4" />
            Opened-cell disclosure
          </div>
          {selected ? (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span>{selected.provider}</span>
                <span aria-hidden="true">·</span>
                <span>{selected.model}</span>
                <span aria-hidden="true">·</span>
                <span>{selected.scenario}</span>
              </div>
              <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">
                {selected.rawResponse}
              </pre>
              {!selected.reasoningOffered && (
                <p className="mt-3 border-t border-slate-700 pt-3 text-xs leading-5 text-slate-400">
                  No reasoning was offered. The bare response is the disclosure.
                </p>
              )}
            </>
          ) : (
            <p className="mt-3 text-xs text-slate-400">No measured cell is available.</p>
          )}
        </section>

        <section className="rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2">
            <Database aria-hidden="true" className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">What this proves</h2>
          </div>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            The claim is not that models are erratic. The claim is that which model you ask changes
            the answer, so Vigil lets deterministic rules decide and uses the model only after sealing.
          </p>
        </section>
      </div>
    </section>
  );
}

function MatrixColumnGroup({ scenarioCount }: { scenarioCount: number }) {
  return (
    <colgroup>
      <col style={{ width: "16rem" }} />
      {Array.from({ length: scenarioCount }, (_, index) => <col key={index} />)}
      <col style={{ width: "12rem" }} />
    </colgroup>
  );
}

function ProviderCell({ provider, cells }: { provider: string; cells: DivergenceCell[] }) {
  return (
    <th
      scope="row"
      className="w-64 py-4 text-left align-top"
      style={{ paddingLeft: 28, paddingRight: 20 }}
    >
      <span className="block text-sm font-semibold">{provider}</span>
      <span className="mt-1 block max-w-44 break-words font-mono text-xs font-normal leading-4 text-muted-foreground">
        {cells.find((cell) => cell.provider === provider)?.model}
      </span>
    </th>
  );
}

function DecisionCell({
  cell,
  selected,
  onSelect,
}: {
  cell: DivergenceCell;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <td className="px-4 py-3 align-top">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        title={`Open ${cell.provider} ${cell.scenario} response`}
        className={cn(
          "flex min-h-14 w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          DECISION_TONE[cell.decision] ?? "border-border bg-muted/40",
          cell.divergesFromEngine && "ring-2 ring-red-500",
          selected && "outline outline-2 outline-offset-2 outline-foreground/30",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-sm font-semibold">{cell.decision}</span>
          <span className="mt-1 block text-xs opacity-80">{cell.agreed}/{cell.samples} consistent</span>
        </span>
        {cell.divergesFromEngine && <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />}
      </button>
    </td>
  );
}

function SummaryCard({
  icon: Icon,
  title,
  detail,
  tone = "default",
}: {
  icon: typeof CheckCircle2;
  title: string;
  detail: string;
  tone?: "default" | "danger" | "success";
}) {
  return (
    <section className={cn(
      "rounded-lg border bg-card p-4",
      tone === "danger" && "border-red-300 bg-red-50 text-red-800",
      tone === "success" && "border-emerald-300 bg-emerald-50 text-emerald-800",
    )}>
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-2 text-xs leading-5 opacity-80">{detail}</p>
        </div>
      </div>
    </section>
  );
}

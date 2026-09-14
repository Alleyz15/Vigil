"use client";

import { useState } from "react";
import {
  Check,
  CheckCircle2,
  FileJson2,
  FileWarning,
  Link2,
  LoaderCircle,
  ShieldAlert,
} from "lucide-react";
import { tamperWithCopy, verifyLedgerText, type BrowserVerification } from "@/lib/ledger/browser-chain";
import { Button } from "@/components/ui/button";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import { cn } from "@/lib/utils";
import {
  compactLedgerPreview,
  ledgerKinds,
  ledgerPreview,
  tamperLineIndex,
} from "./verify-view-model";

type ResultState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; result: BrowserVerification; lineIndex?: number }
  | { phase: "error"; message: string };

export type LedgerSummary = {
  scenario: string;
  records: number | null;
  aborts: number | null;
};

export function VerifyView({
  scenarios,
  summaries,
}: {
  scenarios: string[];
  summaries: LedgerSummary[];
}) {
  const [scenario, setScenario] = useState(
    scenarios.includes("S0") ? "S0" : (scenarios[0] ?? ""),
  );
  const [text, setText] = useState<string | null>(null);
  const [intact, setIntact] = useState<ResultState>({ phase: "idle" });
  const [tampered, setTampered] = useState<ResultState>({ phase: "idle" });

  async function load(): Promise<string> {
    if (text !== null) return text;
    const response = await fetch(`/api/ledger?scenario=${encodeURIComponent(scenario)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await response.text());
    const body = await response.text();
    setText(body);
    return body;
  }

  async function verify() {
    setIntact({ phase: "loading" });
    try {
      const body = await load();
      setIntact({ phase: "done", result: await verifyLedgerText(body) });
    } catch (caught) {
      setIntact({ phase: "error", message: (caught as Error).message });
    }
  }

  async function demonstrateTampering() {
    setTampered({ phase: "loading" });
    try {
      const body = await load();
      const lineIndex = tamperLineIndex(ledgerPreview(body, Number.POSITIVE_INFINITY).length);
      const altered = tamperWithCopy(body, lineIndex);
      setTampered({
        phase: "done",
        result: await verifyLedgerText(altered),
        lineIndex,
      });
    } catch (caught) {
      setTampered({ phase: "error", message: (caught as Error).message });
    }
  }

  function changeScenario(next: string) {
    setScenario(next);
    setText(null);
    setIntact({ phase: "idle" });
    setTampered({ phase: "idle" });
  }

  const busy = intact.phase === "loading" || tampered.phase === "loading";
  const kinds = text === null ? [] : ledgerKinds(text);
  const preview = text === null ? [] : compactLedgerPreview(text);

  return (
    <div className="pb-8">
      <header className="mb-5">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Link2 aria-hidden="true" className="size-5" />
          </span>
          <div>
            <h1 className="text-3xl font-semibold leading-tight">Verify the audit trail</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Recompute the hash chain in your own browser. Do not take our word for it.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 pl-14">
          <ProvenanceLabel>Hashes computed client-side via Web Crypto</ProvenanceLabel>
          <ProvenanceLabel>Seeded synthetic ledger</ProvenanceLabel>
          <ProvenanceLabel>Raw .jsonl bytes, no server verdict</ProvenanceLabel>
        </div>
      </header>

      <section
        data-ledger-selector="true"
        className="mb-5 flex flex-wrap items-end gap-4 rounded-lg border bg-card py-4"
        style={{ paddingInline: 20 }}
      >
        <label className="text-xs text-muted-foreground">
          <span className="mb-1 block">Scenario ledger</span>
          <select
            aria-label="Scenario ledger"
            className="h-9 w-40 rounded-md border bg-background px-3 text-sm text-foreground"
            value={scenario}
            onChange={(event) => changeScenario(event.target.value)}
          >
            {scenarios.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>

        <p className="mb-2 text-xs text-muted-foreground">
          Available: {scenarios.join(", ") || "none"}
        </p>

        <div className="ml-auto flex items-center gap-3">
          <Button className="w-40" size="sm" onClick={verify} disabled={busy || !scenario}>
            {intact.phase === "loading" ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <CheckCircle2 aria-hidden="true" />}
            Verify the chain
          </Button>
          <Button className="w-48" size="sm" variant="outline" onClick={demonstrateTampering} disabled={busy || !scenario}>
            {tampered.phase === "loading" ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <FileWarning aria-hidden="true" />}
            Demonstrate tamper
          </Button>
        </div>
      </section>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <VerificationCard kind="intact" state={intact} />
        <VerificationCard kind="tampered" state={tampered} />

        <section className="rounded-lg border bg-card p-5">
          <h2 className="text-base font-semibold">What this actually checks</h2>
          <ul className="mt-4 space-y-4 text-sm text-muted-foreground">
            {[
              "Sequence number equals its position in the file",
              "prevHash equals the previous record entryHash",
              "entryHash is recomputed from content, not trusted",
              "Malformed JSON names the broken line index",
              "Tamper demo edits only a browser-held copy",
            ].map((item) => (
              <li key={item} className="flex items-start gap-3">
                <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-700" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border bg-card p-5">
          <h2 className="text-base font-semibold">Append-only chain shape</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The ledger is a file, not a mutable table. If projection and ledger disagree, the ledger wins.
          </p>

          {kinds.length > 0 ? (
            <div className="mt-5 flex items-center overflow-x-auto pb-2">
              {kinds.map((kind, index) => (
                <div key={`${index}-${kind}`} className="flex shrink-0 items-center">
                  {index > 0 && (
                    <div className="flex w-16 shrink-0 flex-col items-center gap-2">
                      <span className="text-xs text-muted-foreground">prevHash</span>
                      <span className="h-px w-full bg-border" aria-hidden="true" />
                    </div>
                  )}
                  <div className={cn("w-24 rounded-md border bg-background p-3", kind === "abort" && "bg-orange-50")}>
                    <div className="font-mono text-xs font-semibold">seq {index}</div>
                    <div className={cn("mt-2 text-xs font-medium text-emerald-700", kind === "abort" && "text-orange-700")}>{kind}</div>
                    <div className="mt-2 text-xs text-muted-foreground">entryHash</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-5 rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
              Verify or demonstrate tampering to inspect the selected ledger&apos;s first records.
            </div>
          )}

          <p className="mt-5 rounded-md border bg-muted/40 px-4 py-3 text-xs leading-5 text-muted-foreground">
            <span className="font-mono">/api/ledger</span> is GET-only and serves raw text with
            <span className="font-mono"> cache-control: no-store</span>. Verification happens after the browser receives the bytes.
          </p>
        </section>

        <section className="self-start rounded-lg border bg-card p-5">
          <h2 className="text-sm font-semibold">Seeded scenario ledgers</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {summaries.map((summary) => {
              const records = summary.records === null ? "unreadable" : String(summary.records);
              const abort = summary.aborts ? ` with ${summary.aborts} abort${summary.aborts === 1 ? "" : "s"}` : "";
              return `${summary.scenario} ${records}${abort}`;
            }).join(" · ")}
          </p>
        </section>

        <section className="overflow-hidden rounded-lg bg-[#07111f] p-5 text-slate-200">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
            <FileJson2 aria-hidden="true" className="size-4" />
            Raw ledger preview
          </div>
          {preview.length > 0 ? (
            <pre className="mt-3 max-h-28 overflow-hidden whitespace-pre-wrap break-all font-mono text-xs leading-5">
              {preview.join("\n")}
            </pre>
          ) : (
            <p className="mt-3 text-xs text-slate-400">Raw bytes appear here after a local verification action.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function VerificationCard({ kind, state }: { kind: "intact" | "tampered"; state: ResultState }) {
  const isIntact = kind === "intact";
  const done = state.phase === "done";
  const tone = done
    ? state.result.valid
      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
      : "border-red-300 bg-red-50 text-red-800"
    : state.phase === "error"
      ? "border-red-300 bg-red-50 text-red-800"
      : "border-border bg-card text-foreground";

  let title = isIntact ? "Chain verification not run" : "Tamper demonstration not run";
  let detail = isIntact
    ? "Run the browser verifier against the selected raw ledger."
    : "Alter a browser-held copy and verify that the first changed record is located.";
  let foot = "No result asserted yet";

  if (state.phase === "loading") {
    title = isIntact ? "Verifying the chain" : "Verifying a tampered copy";
    detail = "The browser is recomputing entry hashes with Web Crypto.";
    foot = "Local calculation in progress";
  } else if (state.phase === "error") {
    title = "Verification could not run";
    detail = state.message;
    foot = "No result asserted";
  } else if (done) {
    const result = state.result;
    if (result.valid) {
      title = `Chain intact across ${result.entries} records`;
      detail = "Every entry hash was recomputed from the record's own content and every link matches the one before it.";
      foot = `${result.records} records read · hashes computed in this browser`;
    } else {
      title = `${isIntact ? "Chain" : "Tamper copy"} breaks at record ${result.brokenAt}`;
      detail = isIntact
        ? result.reason
        : "One line of a copy was altered in this page without restating its entryHash. The real ledger file is untouched.";
      foot = isIntact
        ? result.reason
        : `Record ${state.lineIndex} changed in the copy · reports an index, not just "something is wrong"`;
    }
  }

  return (
    <section className={cn("min-h-44 rounded-lg border p-5", tone)} aria-live="polite">
      <div className="flex items-start gap-3">
        {state.phase === "loading" ? (
          <LoaderCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 animate-spin" />
        ) : done && state.result.valid ? (
          <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        ) : done || state.phase === "error" ? (
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        ) : (
          <FileJson2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 opacity-80">{detail}</p>
          <p className="mt-5 font-mono text-xs opacity-65">{foot}</p>
        </div>
      </div>
    </section>
  );
}

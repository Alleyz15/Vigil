"use client";

import { useState } from "react";
import { CheckCircle2, FileWarning, Link2, ShieldAlert } from "lucide-react";
import { tamperWithCopy, verifyLedgerText, type BrowserVerification } from "@/lib/ledger/browser-chain";
import { Button } from "@/components/ui/button";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import { cn } from "@/lib/utils";

/**
 * Check the audit trail yourself.
 *
 * EVERY HASH ON THIS PAGE IS COMPUTED IN YOUR BROWSER. The server hands over
 * the raw `.jsonl` and nothing else — no verdict, no "valid: true". That is the
 * whole point: a server telling you its own file is intact is the party that
 * wrote the file vouching for it. The chain walk here is the same
 * implementation `NonceLedger.verifyChain()` runs, so the page and the server
 * cannot reach different conclusions; only the digest primitive differs.
 */

type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; result: BrowserVerification; tampered: boolean; lineIndex?: number }
  | { phase: "error"; message: string };

export function VerifyView({ scenarios }: { scenarios: string[] }) {
  const [scenario, setScenario] = useState(scenarios[0] ?? "");
  const [state, setState] = useState<State>({ phase: "idle" });
  const [text, setText] = useState<string | null>(null);

  async function load(): Promise<string | null> {
    const response = await fetch(`/api/ledger?scenario=${encodeURIComponent(scenario)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await response.text());
    const body = await response.text();
    setText(body);
    return body;
  }

  async function verify() {
    setState({ phase: "loading" });
    try {
      const body = text ?? (await load());
      if (body === null) throw new Error("no ledger returned");
      setState({ phase: "done", result: await verifyLedgerText(body), tampered: false });
    } catch (caught) {
      setState({ phase: "error", message: (caught as Error).message });
    }
  }

  async function demonstrateTampering() {
    setState({ phase: "loading" });
    try {
      const body = text ?? (await load());
      if (body === null) throw new Error("no ledger returned");

      const lines = body.split("\n").filter((line) => line.trim().length > 0);
      // Somewhere in the middle, so the report shows a break that is neither
      // the first nor the last record — an index, not a boolean.
      const lineIndex = Math.min(2, Math.max(0, lines.length - 1));

      // A COPY. Nothing here can write to the ledger; the string below never
      // leaves the browser.
      const altered = tamperWithCopy(body, lineIndex);
      setState({
        phase: "done",
        result: await verifyLedgerText(altered),
        tampered: true,
        lineIndex,
      });
    } catch (caught) {
      setState({ phase: "error", message: (caught as Error).message });
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-2 flex items-center gap-2.5">
        <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Link2 aria-hidden="true" className="size-5" />
        </span>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Verify the audit trail</h1>
          <p className="text-sm text-muted-foreground">
            Recompute the hash chain in your own browser. Do not take our word for it.
          </p>
        </div>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <ProvenanceLabel>Hashes computed client-side via Web Crypto</ProvenanceLabel>
        <ProvenanceLabel>Seeded synthetic ledger</ProvenanceLabel>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {scenarios.length > 1 && (
          <select
            aria-label="Scenario ledger"
            className="h-9 rounded-md border bg-card px-2.5 text-sm"
            value={scenario}
            onChange={(event) => {
              setScenario(event.target.value);
              setText(null);
              setState({ phase: "idle" });
            }}
          >
            {scenarios.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        )}
        <Button size="sm" onClick={verify} disabled={state.phase === "loading"}>
          Verify the chain
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={demonstrateTampering}
          disabled={state.phase === "loading"}
        >
          Demonstrate tampering
        </Button>
      </div>

      {state.phase === "error" && (
        <p role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {state.message}
        </p>
      )}

      {state.phase === "done" && <Result state={state} />}

      <section className="mt-8 border-t pt-5">
        <h2 className="text-sm font-semibold">What this actually checks</h2>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-xs leading-5 text-muted-foreground">
          <li>Each record&rsquo;s sequence number is its position in the file.</li>
          <li>Each record&rsquo;s <span className="font-mono">prevHash</span> equals the previous record&rsquo;s <span className="font-mono">entryHash</span>.</li>
          <li>
            Each <span className="font-mono">entryHash</span> is <strong>recomputed</strong> from the
            record&rsquo;s own content — not compared against itself, which would verify nothing.
          </li>
          <li>
            The tamper demo edits a <strong>copy held in this page</strong>. The ledger file is never
            written to, and there is no endpoint that could.
          </li>
        </ul>
      </section>
    </div>
  );
}

function Result({ state }: { state: Extract<State, { phase: "done" }> }) {
  const { result, tampered, lineIndex } = state;
  const ok = result.valid;

  return (
    <div
      className={cn(
        "rounded-lg border p-5",
        ok ? "border-emerald-500/40 bg-emerald-500/5" : "border-red-500/40 bg-red-500/5",
      )}
    >
      <div className="flex items-start gap-2.5">
        {ok ? (
          <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-emerald-700 dark:text-emerald-400" />
        ) : tampered ? (
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-red-700 dark:text-red-400" />
        ) : (
          <FileWarning aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-red-700 dark:text-red-400" />
        )}

        <div className="min-w-0">
          <p className={cn("text-base font-semibold", ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
            {ok
              ? `Chain intact across ${result.entries} records`
              : `Chain breaks at record ${result.brokenAt}`}
          </p>

          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {ok
              ? "Every entry hash was recomputed from the record's own content and every link matches the one before it."
              : result.reason}
          </p>

          {tampered && (
            <p className="mt-3 rounded-md border bg-background/60 px-3 py-2 text-xs leading-5">
              One line of a <strong>copy</strong> was altered in this page
              {lineIndex !== undefined && <> (record <span className="font-mono">{lineIndex}</span>)</>}
              , without restating its <span className="font-mono">entryHash</span>. The chain located
              the edit by index rather than merely reporting that something was wrong. The real
              ledger file is untouched — reload and verify again.
            </p>
          )}

          <p className="mt-3 font-mono text-[11px] text-muted-foreground">
            {result.records} records read · hashes computed in this browser
          </p>
        </div>
      </div>
    </div>
  );
}

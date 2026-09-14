import { readFileSync } from "node:fs";
import { VerifyView, type LedgerSummary } from "@/components/ledger/verify-view";
import { parseLedgerJsonl } from "@/lib/ledger/chain";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function VerifyPage() {
  const workbench = await getWorkbench();
  const scenarios = workbench.ledgerScenarios();
  const summaries: LedgerSummary[] = scenarios.map((scenario) => {
    const source = workbench.ledgerSource(scenario);
    if (!source) return { scenario, records: null, aborts: null };

    try {
      const parsed = parseLedgerJsonl(readFileSync(source.path, "utf8"));
      if (!parsed.ok) return { scenario, records: null, aborts: null };
      return {
        scenario,
        records: parsed.records.length,
        aborts: parsed.records.filter((record) => record.kind === "abort").length,
      };
    } catch {
      return { scenario, records: null, aborts: null };
    }
  });

  return <VerifyView scenarios={scenarios} summaries={summaries} />;
}

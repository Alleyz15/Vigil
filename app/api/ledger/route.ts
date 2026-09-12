import { readFileSync } from "node:fs";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

/**
 * Serve the raw ledger `.jsonl` so a visitor can verify it themselves.
 *
 * RAW TEXT, NOT A VERDICT. An endpoint returning `{ valid: true }` proves
 * nothing to a sceptic — it is the party that wrote the file telling them the
 * file is fine. Handing over the bytes and letting their browser recompute the
 * chain is the only version of this that is worth anything, so this route
 * deliberately does no verification of its own.
 *
 * READ ONLY. There is no POST here and there must never be one: the ledger is
 * append-only and the only writer is the agent sealing a verdict.
 */
export async function GET(request: Request) {
  const scenario = new URL(request.url).searchParams.get("scenario");
  const workbench = await getWorkbench();
  const source = workbench.ledgerSource(scenario ?? undefined);

  if (!source) {
    return new Response("no ledger found for that scenario", { status: 404 });
  }

  let text: string;
  try {
    text = readFileSync(source.path, "utf8");
  } catch {
    // An unreadable ledger is reported as unreadable rather than as an empty
    // one: "nothing to verify" and "we could not show it to you" are different
    // statements and only one of them is reassuring.
    return new Response("ledger could not be read", { status: 500 });
  }

  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-vigil-scenario": source.scenarioId,
    },
  });
}

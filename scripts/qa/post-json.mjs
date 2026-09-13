/**
 * ONE RETRY, ON A TRANSPORT FAILURE ONLY. NOT A FIX.
 *
 * The approval POST has reset with ECONNRESET on three of five fresh-server
 * runs, with no line for the request in the dev log, and two hypotheses for why
 * did not reproduce it (CLAUDE.md, Known Limitations). The cause is unknown. A
 * retry exists so that an intermittent fault does not destroy a recording run —
 * on the day the demo is captured there is no time to diagnose it.
 *
 * It retries only when `fetch` itself throws (no response at all). An HTTP
 * refusal is an answer and is never retried. `retried` is returned so the
 * caller can treat a refusal AFTER a reset as ambiguous: the first attempt may
 * have been applied before the connection dropped.
 */
export async function postJson(url, body, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      return {
        status: response.status,
        ok: response.ok,
        body: await response.json().catch(() => null),
        retried: attempt > 1,
      };
    } catch (error) {
      const code = error?.cause?.code ?? error?.message ?? "unknown";
      if (attempt === attempts) {
        throw new Error(`POST ${url} failed twice without a response (${code}); giving up`);
      }
      console.warn(`  POST ${url} got no response (${code}); retrying once`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("unreachable");
}

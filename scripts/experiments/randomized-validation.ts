import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createMigratedDb } from "../../lib/db/migrate";
import { createWorkbench, type OperatorWorkbench } from "../../lib/workbench/service";
import { resolveRuntimeLlm } from "../../lib/llm/runtime";
import { canonicalHash } from "../../lib/ledger";
import { runSeedManifest, type SeedPartition } from "../../lib/simulation/validation";

async function main() {
const destination = resolve(process.argv[2] ?? "tmp/randomized-validation-signals-v1.json");
const contexts = new Map<SeedPartition, OperatorWorkbench>();
try {
  const report = await runSeedManifest(async (seed, partition) => {
    let workbench = contexts.get(partition);
    if (!workbench) {
      workbench = await createWorkbench({ scenarioIds: ["S0"], runtimeLlm: resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "none" }) });
      workbench.configureOnline({ store: createMigratedDb(":memory:"), boundary: {
        version: "offline-validation-fixture", source: "synthetic rectangular test boundary", licence: "n/a",
        area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [
          [[101.6, 3.1], [101.76, 3.1], [101.76, 3.2], [101.6, 3.2], [101.6, 3.1]],
        ] } },
      } });
      contexts.set(partition, workbench);
    }
    const courierId = `CR-100${Number(seed.slice(-3)) % 4}`;
    const request = { origin: { latitude: 3.13, longitude: 101.67 }, destination: { latitude: 3.165, longitude: 101.73 },
      declaredValueSen: 18_000, recipientChannel: "+60110000000",
      simulation: { mode: "randomized" as const, seed, version: "signals-v1" as const } };
    const created = await workbench.createOnlineShipment(request, seed, { awaitAssignment: true });
    if (created.status !== "created") throw new Error(`Unexpected creation status: ${created.status}`);
    const handoffId = `online:${created.shipmentId}`;
    await workbench.assignDispatch(handoffId, courierId);
    const submitted = await workbench.submitCourierHandoff(handoffId, { signed: true, courierId });
    const detail = workbench.getHandoff(submitted.item.eventId)!;
    process.stdout.write(`${partition} ${seed}: ${detail.gate?.decision ?? "unavailable"}\n`);
    return { source: "synthetic", request, courierId, simulation: detail.simulation,
      eventId: submitted.item.eventId, eventHash: canonicalHash(detail.event),
      computedDecision: detail.gate?.decision ?? null, sealed: detail.summary.sealed,
      state: detail.summary.state, singleEvent: detail.summary.inconsistency, pattern: detail.summary.pattern,
      checks: detail.checks, flags: detail.flags.map(({ id }) => id),
      patternCoverage: detail.summary.patternCoverageLine ?? null };
  });
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.summary)}\nReport: ${destination}\n`);
  process.exitCode = report.summary.errors ? 1 : 0;
} finally { for (const workbench of contexts.values()) workbench.close(); }
}
main().catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });

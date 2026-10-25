/** Fixed before running the experiment. These lists must never be searched for alerts. */
export const RANDOMIZED_SEED_MANIFEST = Object.freeze({
  version: "signals-v1" as const,
  development: Object.freeze(Array.from({ length: 20 }, (_, i) => `signals-v1-development-${String(i + 1).padStart(3, "0")}`)),
  validation: Object.freeze(Array.from({ length: 10 }, (_, i) => `signals-v1-validation-${String(i + 1).padStart(3, "0")}`)),
});
export type SeedPartition = "development" | "validation";

export async function runSeedManifest<T>(execute: (seed: string, partition: SeedPartition) => Promise<T>) {
  const results: Array<{ seed: string; partition: SeedPartition } & ({ status: "completed"; result: T } | { status: "error"; error: string })> = [];
  for (const partition of ["development", "validation"] as const) {
    for (const seed of RANDOMIZED_SEED_MANIFEST[partition]) {
      try { results.push({ seed, partition, status: "completed", result: await execute(seed, partition) }); }
      catch (error) {
        let message = "unprintable error";
        try { message = String(error instanceof Error ? error.message : error); } catch { /* Keep the failure row even if error formatting fails. */ }
        results.push({ seed, partition, status: "error", error: message });
      }
    }
  }
  const errors = results.filter((row) => row.status === "error").length;
  return { manifest: RANDOMIZED_SEED_MANIFEST, claim: "Synthetic mechanism validation; not measured field accuracy or calibrated fraud prevalence.",
    summary: { total: results.length, completed: results.length - errors, errors }, results };
}

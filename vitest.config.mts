import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    // Everything under lib/ is plain Node code - no jsdom, no React.
    environment: "node",
    /**
     * 20 seconds, not vitest's generic 5.
     *
     * A handful of tests genuinely take seconds: the noise model's uniformity
     * check builds 400 timelines, and several scenario tests run whole
     * six-leg shipments through the real agent, real SQLite and a real ledger.
     * Under any load — a dev server and a headless Chrome alongside, which is
     * the normal state of a session doing visual verification — those cross 5s
     * and the suite reports THREE FAILURES IN lib/generate that pass on their
     * own.
     *
     * That failure mode is worse than a slow suite: it looks exactly like a
     * regression in the generator, in files the session did not touch, and it
     * invites someone to go and "fix" code that was never broken. Session 17A
     * already reached this conclusion for the coverage runner; this is the
     * same call for the default run.
     *
     * It is a ceiling, not a budget. Nothing here should take 20 seconds, and
     * a test that starts to is a real finding.
     */
    testTimeout: 20_000,
    include: [
      "lib/**/*.test.ts",
      "components/**/*.test.ts",
      "app/**/*.test.ts",
      "scripts/experiments/**/*.test.ts",
    ],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
});

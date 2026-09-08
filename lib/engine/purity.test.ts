import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The engine must be pure.
 *
 * This is the test that makes the project's central claim mechanically true
 * rather than merely asserted. "Remove the LLM and the verdicts are identical"
 * only holds if the verdict path cannot reach a model, a network, a database or
 * a clock — so this test reads the engine's own source and fails if any of them
 * appear.
 *
 * A future session that "just needs to look one thing up" inside a rule will be
 * stopped here, with a message saying why.
 */

const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));

/** Source modules on the verdict path. Fixtures and tests are exempt. */
const VERDICT_PATH_MODULES = [
  "thresholds.ts",
  "types.ts",
  "custody.ts",
  "geo.ts",
  "hard.ts",
  "inconsistency.ts",
  "engine.ts",
];

/**
 * Each entry is [human-readable name, pattern, why it is banned].
 * Patterns are matched against the module source with comments stripped, so a
 * comment discussing `fetch` does not trip the check.
 */
const FORBIDDEN: [string, RegExp, string][] = [
  ["node builtins", /from\s+["']node:/, "I/O would make the verdict depend on the environment"],
  [
    "bare node modules",
    /from\s+["'](fs|path|http|https|net|dns|child_process|os|crypto)["']/,
    "I/O would make the verdict depend on the environment",
  ],
  ["the database", /from\s+["'].*(drizzle|better-sqlite3|\/lib\/db).*["']/, "the caller assembles inputs; rules do not query"],
  ["the ledger", /from\s+["'].*\/lib\/ledger.*["']/, "H4 belongs to the ledger, not to the engine"],
  ["the agent", /from\s+["'].*\/lib\/agent.*["']/, "the engine must not know an agent exists"],
  ["network access", /\bfetch\s*\(/, "a verdict that depends on a network call is not reproducible"],
  ["randomness", /Math\.random\s*\(/, "a verdict must be identical on every run"],
  ["the wall clock", /Date\.now\s*\(/, "a verdict must not change because time passed"],
  ["the wall clock", /new\s+Date\s*\(\s*\)/, "a verdict must not change because time passed"],
  ["environment variables", /process\.env/, "configuration arrives via the thresholds argument"],
  ["console output", /console\./, "a pure function does not narrate"],
];

/** Strip block and line comments so prose about `fetch` is not mistaken for a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the engine is pure", () => {
  it.each(VERDICT_PATH_MODULES)("%s reaches nothing outside its arguments", (moduleName) => {
    const source = stripComments(readFileSync(join(ENGINE_DIR, moduleName), "utf8"));

    for (const [name, pattern, reason] of FORBIDDEN) {
      expect(
        pattern.test(source),
        `${moduleName} appears to use ${name}. This is banned: ${reason}.`,
      ).toBe(false);
    }
  });

  it("names every module on the verdict path, so a new one cannot slip past unchecked", () => {
    // If a module is added to lib/engine/ and not listed above, this fails.
    const index = readFileSync(join(ENGINE_DIR, "index.ts"), "utf8");
    const exported = [...index.matchAll(/from\s+"\.\/([\w-]+)"/g)].map((m) => `${m[1]}.ts`);

    for (const moduleName of exported) {
      expect(
        VERDICT_PATH_MODULES,
        `${moduleName} is exported from lib/engine but is not covered by the purity check`,
      ).toContain(moduleName);
    }
  });

  it("catches a violation when one is introduced", () => {
    // Guards the guard: a stripComments bug that ate everything would make the
    // checks above pass vacuously.
    const violating = stripComments(`
      // this comment mentions fetch( and should be ignored
      const x = Math.random();
    `);
    expect(/Math\.random\s*\(/.test(violating)).toBe(true);
    expect(/\bfetch\s*\(/.test(violating)).toBe(false);
  });
});

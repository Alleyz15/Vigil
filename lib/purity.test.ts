import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The verdict path must be pure, and the two axes must never be summed.
 *
 * These are the tests that make the project's two central architectural claims
 * mechanically true rather than merely asserted in a README. "Remove the LLM
 * and the verdicts are identical" only holds if the verdict path cannot reach a
 * model, a network, a database or a clock. "The axes are never summed" only
 * holds if nothing outside the gate combines them.
 *
 * Both are checked by reading the source. A future session that "just needs to
 * look one thing up" inside a rule, or that "simplifies" the two scores into
 * one number, is stopped here with a message saying why.
 */

const LIB = dirname(fileURLToPath(import.meta.url));

/**
 * The three pure trees, and the modules on each one's verdict path.
 * Fixtures and tests are exempt: they may read files and build scenarios.
 */
const PURE_TREES: Record<string, string[]> = {
  engine: [
    "thresholds.ts",
    "types.ts",
    "custody.ts",
    "geo.ts",
    "hard.ts",
    "inconsistency.ts",
    "engine.ts",
  ],
  pattern: ["thresholds.ts", "types.ts", "rules.ts", "pattern.ts"],
  gate: ["thresholds.ts", "types.ts", "gate.ts"],
};

/** Files a tree may contain without being on the verdict path. */
const EXEMPT = new Set(["index.ts", "fixtures.ts"]);

const FORBIDDEN: [string, RegExp, string][] = [
  ["node builtins", /from\s+["']node:/, "I/O would make the verdict depend on the environment"],
  [
    "bare node modules",
    /from\s+["'](fs|path|http|https|net|dns|child_process|os|crypto)["']/,
    "I/O would make the verdict depend on the environment",
  ],
  [
    "the database",
    /from\s+["'].*(drizzle|better-sqlite3|\/lib\/db).*["']/,
    "the caller assembles inputs; rules do not query",
  ],
  ["the ledger", /from\s+["'].*\/lib\/ledger\/ledger.*["']/, "H4 belongs to the ledger, not the verdict path"],
  ["the agent", /from\s+["'].*\/lib\/agent.*["']/, "the verdict path must not know an agent exists"],
  ["network access", /\bfetch\s*\(/, "a verdict that depends on a network call is not reproducible"],
  ["randomness", /Math\.random\s*\(/, "a verdict must be identical on every run"],
  ["the wall clock", /Date\.now\s*\(/, "a verdict must not change because time passed"],
  ["the wall clock", /new\s+Date\s*\(\s*\)/, "a verdict must not change because time passed"],
  ["environment variables", /process\.env/, "configuration arrives via the thresholds argument"],
  ["console output", /console\./, "a pure function does not narrate"],
];

/** Strip block and line comments so prose about `fetch` is not read as a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const read = (tree: string, file: string) =>
  stripComments(readFileSync(join(LIB, tree, file), "utf8"));

describe.each(Object.entries(PURE_TREES))("lib/%s is pure", (tree, modules) => {
  it.each(modules)("%s reaches nothing outside its arguments", (moduleName) => {
    const source = read(tree, moduleName);

    for (const [name, pattern, reason] of FORBIDDEN) {
      expect(
        pattern.test(source),
        `lib/${tree}/${moduleName} appears to use ${name}. This is banned: ${reason}.`,
      ).toBe(false);
    }
  });

  it("has no module on its verdict path that the check does not cover", () => {
    const present = readdirSync(join(LIB, tree)).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !EXEMPT.has(f),
    );

    for (const file of present) {
      expect(
        modules,
        `lib/${tree}/${file} is on the verdict path but is not covered by the purity check`,
      ).toContain(file);
    }
  });
});

/**
 * THE AXES ARE NEVER SUMMED.
 *
 * Collapsing single-event inconsistency and per-courier pattern into one number
 * makes the low-single/high-pattern quadrant unreachable — the case no per-event
 * system can see, and the only thing this project has that others do not.
 *
 * lib/gate is the sole place both scores are legitimately read. Nowhere, gate
 * included, may they be added, averaged or otherwise combined into a single
 * value. See CLAUDE.md.
 */
describe("the two axes are never combined into one number", () => {
  /** Every non-test source file under lib/. */
  function allSources(dir = LIB): { path: string; source: string }[] {
    const out: { path: string; source: string }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "migrations") continue;
        out.push(...allSources(full));
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push({ path: full.slice(LIB.length + 1).replace(/\\/g, "/"), source: readFileSync(full, "utf8") });
      }
    }
    return out;
  }

  /**
   * Arithmetic joining an inconsistency-shaped term to a pattern-shaped one.
   * Deliberately broad: it is better to make a future author rename a variable
   * than to let a quiet `+` through.
   */
  const COMBINING = [
    /inconsistency\w*\s*[+\-*/]\s*\w*pattern/i,
    /pattern\w*\s*[+\-*/]\s*\w*inconsistency/i,
    /\bsingle\w*Score\s*[+\-*/]\s*\w*patternScore/i,
    /\bpatternScore\s*[+\-*/]\s*\w*(single|inconsistency)\w*Score/i,
  ];

  it("no module under lib/ performs arithmetic across the two axes", () => {
    for (const { path, source } of allSources()) {
      const clean = stripComments(source);
      for (const pattern of COMBINING) {
        expect(
          pattern.test(clean),
          `${path} appears to combine the two axes arithmetically. This is banned: summing them makes the low-single/high-pattern quadrant unreachable, which deletes the project's differentiator.`,
        ).toBe(false);
      }
    }
  });

  it("only lib/gate reads both scores together", () => {
    const readers = allSources()
      .filter(({ path }) => !path.startsWith("gate/"))
      .filter(({ source }) => {
        const clean = stripComments(source);
        return /\binconsistencyScore\b/.test(clean) && /\bpatternScore\b/.test(clean);
      })
      .map(({ path }) => path);

    // These four carry both fields as SEPARATE values and never combine them:
    // the ledger Verdict and the DB schema store them in distinct columns,
    // machine.ts reports each in its own SSE trace frame, and nodes.ts copies
    // them across. The arithmetic check above is what proves they stay apart.
    // Anything else reading both belongs in lib/gate.
    expect(readers.sort()).toEqual([
      "agent/machine.ts",
      "agent/nodes.ts",
      "db/schema.ts",
      "ledger/types.ts",
    ]);
  });

  it("catches a violation when one is introduced", () => {
    // Guards the guard: a stripComments bug that ate everything would make the
    // checks above pass vacuously.
    const violating = stripComments(`
      // this comment mentions Math.random( and should be ignored
      const total = inconsistencyScore + patternScore;
    `);
    expect(COMBINING.some((p) => p.test(violating))).toBe(true);
    expect(/Math\.random\s*\(/.test(violating)).toBe(false);
  });
});

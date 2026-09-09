import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
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
 * lib/credential is deterministic, and gets a NARROW allowance rather than a hole.
 *
 * Signature verification needs `node:crypto`, which the blanket rule bans. The
 * allowance is targeted because of WHY node:crypto is safe here: verifying a
 * signature is a pure function of (message, key, signature) — same inputs, same
 * answer, forever. Determinism is the property the purity test actually
 * protects, and crypto does not weaken it. Reading a file or a clock would.
 *
 * Everything else on the banned list still applies, so a future session cannot
 * reach for the database "just to look up a key" inside the verifier — keys
 * arrive as arguments, and lib/credential/keys.ts is the one file allowed to
 * read the environment.
 */
describe("lib/credential is deterministic, with a narrow node:crypto allowance", () => {
  const CRYPTO_ONLY = ["message.ts", "verify.ts", "sign.ts", "types.ts"];

  it.each(CRYPTO_ONLY)("%s reaches nothing impure except node:crypto", (moduleName) => {
    const source = stripComments(readFileSync(join(LIB, "credential", moduleName), "utf8"));

    for (const [name, pattern, reason] of FORBIDDEN) {
      // The one allowance, and only for this exact import.
      if (name === "node builtins" && /from "node:crypto"/.test(source)) {
        const withoutCrypto = source.replace(/from "node:crypto"/g, 'from "<allowed>"');
        expect(
          pattern.test(withoutCrypto),
          `lib/credential/${moduleName} imports a node builtin other than node:crypto.`,
        ).toBe(false);
        continue;
      }
      expect(
        pattern.test(source),
        `lib/credential/${moduleName} appears to use ${name}. This is banned: ${reason}.`,
      ).toBe(false);
    }
  });

  it("keeps process.env to keys.ts alone", () => {
    for (const moduleName of CRYPTO_ONLY) {
      const source = stripComments(readFileSync(join(LIB, "credential", moduleName), "utf8"));
      expect(/process\.env/.test(source), `${moduleName} reads the environment`).toBe(false);
    }

    // And keys.ts really is the one that does, which is why it is excluded.
    const keys = readFileSync(join(LIB, "credential", "keys.ts"), "utf8");
    expect(keys).toMatch(/process\.env/);
  });

  it("never lets the verifier reach the database for a key", () => {
    const verify = stripComments(readFileSync(join(LIB, "credential", "verify.ts"), "utf8"));
    expect(verify).not.toMatch(/lib\/db/);
    expect(verify).not.toMatch(/drizzle/);
  });
});

/**
 * lib/assemble is where the I/O lives, and it must STAY out of the pure trees.
 *
 * The separation is the whole point: assemblers reach for rows, rules do
 * arithmetic on what they are handed. Adding lib/assemble to PURE_TREES would
 * either fail immediately or, worse, tempt someone to move a query into a rule
 * to make the check pass.
 */
describe("lib/assemble is deliberately impure", () => {
  it("is not listed as a pure tree", () => {
    expect(Object.keys(PURE_TREES)).not.toContain("assemble");
  });

  it("really does reach the database, which is why it is excluded", () => {
    const source = readFileSync(join(LIB, "assemble", "engine-input.ts"), "utf8");
    expect(source).toMatch(/from "@\/lib\/db\/schema"/);
  });
});

/**
 * ENFORCEMENT IS NEVER OFF IN THE PRODUCT.
 *
 * `explainVerdict` has a report-only mode so experiment 5 can measure the
 * hallucination rate BEFORE enforcement — a number that is otherwise
 * unobservable, because with enforcement on a bad citation never reaches an
 * operator. It exists for measurement and nothing else.
 *
 * The agent must never pass it. Shipping prose that cites evidence the run
 * never collected is the failure the citation check exists to prevent, and a
 * flag that turns it off is one edit away from being set for a demo and left.
 */
describe("report-only mode is unreachable from the agent", () => {
  it("lib/agent never passes enforce:false", () => {
    for (const file of readdirSync(join(LIB, "agent"))) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = stripComments(readFileSync(join(LIB, "agent", file), "utf8"));

      expect(
        /enforce\s*:\s*false/.test(source),
        `lib/agent/${file} disables citation enforcement. That flag is for experiment 5 only — the product must never ship an explanation citing evidence the run did not collect.`,
      ).toBe(false);
    }
  });

  it("defaults to enforcing when the caller says nothing", () => {
    const source = readFileSync(join(LIB, "llm", "explain.ts"), "utf8");
    expect(source).toMatch(/enforce\s*=\s*true/);
  });
});

/**
 * THE GENERATOR MUST NOT KNOW THE DETECTOR'S THRESHOLDS.
 *
 * This is the fifth architectural claim the suite verifies rather than the
 * README asserts, and it is the one that decides whether the experiments mean
 * anything.
 *
 * A generator that reads `p1.maxDeliveriesInWindow` to decide how fast the
 * fraudster scans is not producing a fraudster; it is producing something
 * shaped to trip a rule. Running the detector over it then measures how well
 * the generator was tuned, and a detection rate obtained that way is circular:
 * it would stay high if the rule were nonsense, because the data was built
 * around the rule.
 *
 * So lib/generate emits BEHAVIOUR — "one parcel every twenty seconds", "the
 * courier is in a basement carpark", "the recipient agrees not to complain" —
 * and the detectors compute statistics over it. The two sides share no
 * parameters. If a threshold moves, the generator does not.
 */
describe("the generator does not import the detector's thresholds", () => {
  const THRESHOLD_MODULES = [
    /\/lib\/engine\/thresholds/,
    /\/lib\/pattern\/thresholds/,
    /\/lib\/gate\/thresholds/,
    // Barrels re-export the thresholds, so importing one is importing them.
    /from\s+["']@\/lib\/(engine|pattern|gate)["']/,
  ];

  function generatorSources(dir = join(LIB, "generate")): { path: string; source: string }[] {
    const out: { path: string; source: string }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...generatorSources(full));
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push({
          path: full.slice(LIB.length + 1).split(sep).join("/"),
          source: readFileSync(full, "utf8"),
        });
      }
    }
    return out;
  }

  /**
   * The experiment scripts fall under the same rule, with ONE exception.
   *
   * E6 varies a threshold as its independent variable — that is the entire
   * experiment — so it is allowed to import one. Every other script is banned,
   * because a script that reads a threshold to decide what the attacker DOES is
   * the circularity in a different file.
   */
  const E6 = "e6-threshold-sensitivity.ts";

  function experimentSources(): { path: string; source: string }[] {
    const root = join(LIB, "..", "scripts", "experiments");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => ({ path: `scripts/experiments/${f}`, source: readFileSync(join(root, f), "utf8") }));
  }

  it("no experiment except e6 reads the detector's thresholds", () => {
    for (const { path, source } of experimentSources()) {
      if (path.endsWith(E6)) continue;
      const clean = stripComments(source);

      for (const pattern of THRESHOLD_MODULES) {
        expect(
          pattern.test(clean),
          `${path} imports the detector's thresholds. The ONLY file allowed to is ${E6}, because varying a threshold is that experiment's independent variable. Everywhere else, reading a threshold to decide what the attacker does makes the result circular — it would stay high if the rule were nonsense. Do not add yourself to this exception; describe behaviour instead.`,
        ).toBe(false);
      }
    }
  });

  it("reads no threshold from any scoring module", () => {
    for (const { path, source } of generatorSources()) {
      // ingest.ts is the harness that RUNS the detector; it may import the
      // agent. It still may not read a threshold.
      const clean = stripComments(source);
      for (const pattern of THRESHOLD_MODULES) {
        expect(
          pattern.test(clean),
          `${path} imports the detector's thresholds. This is banned: a generator tuned against the detector measures how well it was tuned, not how well the detector works. Emit BEHAVIOUR and let the detector compute statistics over it.`,
        ).toBe(false);
      }
    }
  });

  it("names no threshold constant, even without importing one", () => {
    const NAMES = [
      "maxDeliveriesInWindow",
      "maxImpliedSpeedKmh",
      "minHandoffsForPattern",
      "highInconsistency",
      "highPattern",
      "clockDivergence",
      "deliveryDistanceBands",
      "baselineMultiplier",
      "maxStdDev",
    ];

    for (const { path, source } of generatorSources()) {
      const clean = stripComments(source);
      for (const name of NAMES) {
        expect(
          clean.includes(name),
          `${path} refers to the threshold "${name}". The generator must describe behaviour, not target a rule.`,
        ).toBe(false);
      }
    }
  });

  it("draws no randomness outside the seeded stream", () => {
    for (const { path, source } of generatorSources()) {
      const clean = stripComments(source);
      expect(
        /Math\.random\s*\(/.test(clean),
        `${path} uses Math.random, so the dataset cannot be regenerated and any experiment run on it is unrepeatable.`,
      ).toBe(false);
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

    // These carry both fields as SEPARATE values and never combine them: the
    // ledger Verdict, the DB schema and persist.ts keep them in distinct
    // columns, trace.ts declares them as distinct frame fields, and machine.ts
    // and nodes.ts copy them across. The arithmetic check above is what proves
    // they stay apart. Anything else reading both belongs in lib/gate.
    expect(readers.sort()).toEqual([
      "agent/machine.ts",
      "agent/nodes.ts",
      "agent/trace.ts",
      "assemble/persist.ts",
      // The console's read model. Carries both as separate fields for the UI
      // to display side by side, and never combines them.
      "console/dataset.ts",
      "db/schema.ts",
      "ledger/types.ts",
    ]);
  });

  /**
   * THE UI READS BOTH SCORES, AND THAT IS CORRECT.
   *
   * Every view shows the two axes side by side — that is the whole point of the
   * gate explorer and half the point of the timeline. So the "only lib/gate
   * reads both" rule does NOT apply to app/ and components/; the ARITHMETIC ban
   * does, along with a ban on naming a variable as though the two were one
   * number.
   */
  it("no view combines the two axes arithmetically or names them as one number", () => {
    const UI_ROOTS = ["app", "components"];
    const SINGLE_NUMBER_NAMES = [
      "totalScore",
      "riskScore",
      "combinedScore",
      "overallScore",
      "aggregateScore",
      "sumScore",
    ];

    function uiSources(dir: string): { path: string; source: string }[] {
      const out: { path: string; source: string }[] = [];
      const root = join(LIB, "..", dir);
      if (!existsSync(root)) return out;

      const walk = (current: string) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
            out.push({
              path: `${dir}/${full.slice(root.length + 1).split(sep).join("/")}`,
              source: readFileSync(full, "utf8"),
            });
          }
        }
      };
      walk(root);
      return out;
    }

    for (const root of UI_ROOTS) {
      for (const { path, source } of uiSources(root)) {
        const clean = stripComments(source);

        for (const pattern of COMBINING) {
          expect(
            pattern.test(clean),
            `${path} appears to combine the two axes arithmetically. Reading both scores is correct and expected — every view displays them side by side. ADDING them is not: it makes the low-single/high-pattern quadrant unreachable, which deletes the project's differentiator.`,
          ).toBe(false);
        }

        for (const name of SINGLE_NUMBER_NAMES) {
          expect(
            clean.includes(name),
            `${path} names a variable "${name}", as though the two axes were one number. They are two independent measurements and the UI must not imply otherwise — display them separately instead.`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps decorative motion out of the gate explorer and SSE stream", () => {
    const bannedViews = [
      join(LIB, "..", "components", "console", "gate-explorer.tsx"),
      join(LIB, "..", "components", "console", "stream-view.tsx"),
    ];

    for (const path of bannedViews) {
      const source = stripComments(readFileSync(path, "utf8"));
      expect(
        /from\s+["']motion(?:\/react)?["']|\bAnimatePresence\b|<motion\./.test(source),
        `${path} imports decorative motion. Gate threshold feedback must remain instantaneous, and the SSE sequence must show real computation timing rather than animation timing.`,
      ).toBe(false);
    }
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

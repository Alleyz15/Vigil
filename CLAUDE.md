# Vigil

Agentic handoff trust verifier for last-mile logistics fraud.
HackAI 2026, Track 02 (Secure Logistics & Digital Trust). Solo project. Deadline **15 Oct 2026**.

`track idea.md` is the source of truth for the full plan, demo scenarios, experiments and
scoring rubric. This file is the working context: the rules that must survive between sessions.

---

## Core concept

Vigil does **not** try to prove a delivery happened. Every individual signal — photo, GPS,
OTP, signature — can be forged, and any system claiming otherwise is lying. So we change the
question from *"is this delivery real?"* to two answerable ones:

1. **Do these claims agree with each other?** Forging GPS is easy. Making GPS, cell tower,
   WiFi, accelerometer, photo EXIF and server receipt time all tell the same story, dozens of
   times, without leaving a pattern, is expensive.
2. **How many times can a fraudster do this before the shape of their behaviour gives them away?**

Three pillars:

| Pillar | One line |
|---|---|
| Cross-signal consistency | Any one signal is forgeable; all of them agreeing is not |
| Orthogonal gate | Single-event contradiction and cumulative pattern are two independent axes |
| Constitutive approval | Without the operator's signature, a high-risk handoff cannot assemble a valid credential |

---

## Architectural rules

These are not style preferences. Breaking one dismantles the argument the project is built on.

### 1. The verdict is always deterministic

The LLM appears in **exactly two** places:

- `plan` — selecting 0–2 optional tools from a **closed zod enum**
- `explain` — writing human-readable prose **after** the verdict is already sealed

**Removing the LLM entirely must produce byte-identical verdicts.** Only the operator's
explanation degrades, into a structured flag list. Never let an LLM decide accept/reject.
If a change would make a verdict depend on model output, the change is wrong.

This is **enforced, not just asserted**. Every rule in `lib/engine/` is a pure function of its
arguments — the caller assembles `EngineInput`, the rules do arithmetic on it — and
`lib/engine/purity.test.ts` reads the engine's own source and fails the build if any module on
the verdict path reaches a file, a socket, a database, `process.env`, `Math.random`, or the
wall clock. A future session that "just needs to look one thing up" inside a rule is stopped
there, with a message saying why. Thresholds arrive as an argument for the same reason.

### 2. The two axes are separate, and load-bearing

This split is deliberate. **Do not "simplify" it back into a single scoring pass.**

```
verify        -> axis 1: single-event inconsistency  (H1-H4, I1-I14)
fetch_history -> axis 2: per-courier rolling pattern (P1-P5)
gate          -> the ONLY place the two axes meet
```

They are stored as two fields and **never summed**. The reason is the matrix:

| Single-event | Pattern | Outcome |
|---|---|---|
| High | Low | **flag** — probably a device fault (GPS drift in a tunnel), ask for more evidence |
| Low | **High** | **escalate** — every event passes on its own, but the distribution is wrong |
| High | High | **freeze** the scope |
| Low | Low | accept |

Row 2 is the whole project. Every other system does per-event adjudication; a careful
fraudster can keep each event under the threshold, but cannot change their own distribution.
Collapsing the axes into one number makes row 2 unreachable and deletes the differentiator.

The node ordering exists to make this structural rather than merely intended: axis 1 is
produced at `verify`, axis 2 at `fetch_history`, and they are combined nowhere but `gate`.

### 3. Approval is constitutive, not decorative

Operator approval is **not** `approved = true` in a table. A high-risk handoff requires a
token co-signed by the courier's key **and** the operator's key. The courier's half alone
**fails signature verification**. If a judge asks whether the approval button is real, the
answer is: without it, the credential does not verify.

Shift limits are a hard stop **even with a valid co-sign**.

### 4. Missing evidence is not clean evidence

Every rule returns **three** states, never a boolean:

```ts
type RuleResult =
  | { status: "triggered"; flag: Flag }
  | { status: "clear" }              // the signals were there and they agreed
  | { status: "not_evaluated"; reason: string };   // the signals were not there
```

**Do not collapse this into a boolean.** `clear` means two independent signals were compared
and agreed. `not_evaluated` means there was nothing to compare. A courier in a tunnel loses
GPS precision, cell service and WiFi; scoring that absence as "clean" makes **S6 (a tunnel)
arithmetically identical to S1 (spoofing)** — both would score zero on the location rules for
opposite reasons. Those two scenarios are the entire false-positive argument, and the third
state is the only thing that separates them.

The same reasoning applies to `i8IntegrityFailed`: an attestation with verdict `unevaluated`
is `not_evaluated`, never `clear`. Treating silence as approval is how attestation gets defeated.

**Operator-facing output:** the engine returns a `coverage` block, rendered as
**"8 of 14 checks evaluable"** next to the score. This is intended UI, not debug output. A
score of 0 from 12 evaluated checks and a score of 0 from 2 evaluated checks are different
claims, and an operator who cannot tell them apart is being misled by their own dashboard.

### 4a. Every rule that applies to a subset of bizSteps must state its gate

`I10`/`I11` (distance from the recipient address) and `I12` (missing proof of delivery) are
gated to `delivering` and `accepting` via `DELIVERY_STEPS` in `lib/engine/inconsistency.ts`.

Ungated, they fire on **every sortation and line-haul scan in the S0 baseline** — a depot scan
is legitimately 300 km from the recipient and legitimately has no signature, so every normal
parcel would accumulate +45 on I12 alone. That buries the "fewer false alerts" claim the brief
explicitly scores, under thousands of false positives generated by our own rule set.

Any future rule that only makes sense for some business steps must declare its gate explicitly
and return `not_evaluated` outside it. `lib/engine/engine.test.ts` has an S0 regression test —
a full collection → sortation → line-haul → out-for-delivery → delivery timeline that must
score **0 at every leg**. If a rule change breaks the false-positive claim, that test fails
before a judge ever sees the number.

### 5. A double-tap is never a fraud alert

The nonce ledger hashes the **canonicalised parsed payload**, not raw request bytes. A retry
that merely reorders JSON keys — which HTTP clients, proxies and retry libraries do routinely
— must hash identically and return the original verdict as a NO-OP.

Hashing raw bytes would turn a courier tapping twice in a dead spot into an `EVENT_ID_REUSE`
forgery alert against a real person. **False positives are an explicit scoring criterion in
this competition**, and that one would be the worst kind: confidently wrong, and aimed at
someone who did nothing.

### 6. The ledger is a file, not a table

`data/ledger/nonce-ledger.jsonl` is append-only and hash-chained (`prevHash` -> `entryHash`).
A table is mutable by anyone with a connection, and "we only ever INSERT" is a promise about
our code; a hash-chained file is a property of the artefact. `verifyChain()` returns the
**index** of the first break, so tampering is located, not just detected.

The `verdicts` table is a queryable projection for the console. If it ever disagrees with the
ledger, **the ledger wins**.

### 7. A failed forgery is evidence, not a discard

An `EVENT_ID_REUSE` rejection writes an **abort record** to the ledger. Someone attempting to
reuse a legitimate `eventID` with different content is the single most incriminating thing in
the dataset, and throwing it away because it "didn't succeed" would discard the best evidence
the system ever sees. An audit trail that records only what was accepted is not an audit trail.

This is a **demo beat**: show the attempt sitting in the chain, immutably, next to the verdict
it tried to overwrite. Abort records never create or overwrite an eventID binding, so an
attacker cannot rebind an ID by submitting a forgery after the fact.

### 8. A mocked attestation must never look real in our own data

`VigilDeviceIntegrity.attestationSource` is **required**, with no default, and must be one of
`mocked | play-integrity | device-check`.

Do not make it optional. Do not give it a default. Do not infer it.

The prototype simulates Play Integrity, and a simulated attestation that is indistinguishable
from a real one *inside our own dataset* is precisely the forgery this project claims to
detect. Defaulting the field would mean our own synthetic data commits the fraud we are
selling a defence against — and a judge who spots that has grounds to discount every number
in the submission. The cost of keeping it required is one explicit field per fixture.

---

## Stack — decided, do not substitute

- Next.js (App Router) + TypeScript, Node 22+ (running 24)
- **zod** — a core dependency, not a helper. It carries the closed tool enum and the
  fail-closed citation check
- SQLite + better-sqlite3 + Drizzle ORM
- Append-only `.jsonl` for the nonce ledger (deliberately not a DB table)
- Node built-in `crypto` for Ed25519 and sha256 — no external crypto library
- `@turf/turf` for geo math, `seedrandom` for reproducible synthetic data
- Tailwind 4 + shadcn/ui, ECharts for the two-axis gate explorer, native `EventSource` for SSE
- **No animation libraries** — no framer-motion, no GSAP, no three.js
- vitest

### Dependency decisions

**`npm audit` reports 4 moderate advisories. Leave them.** They are a dev-server esbuild issue
(GHSA-67mh-4wv8-2f99) reached only through drizzle-kit's transitive `@esbuild-kit/*` deps.
`npm audit fix --force` "resolves" it by downgrading drizzle-kit to 0.18.1, which is a breaking
change to our migration tooling to patch something that never runs in production and is not
reachable from anything we ship. **Do not run `npm audit fix --force`.**

**`@types/node` is pinned to `^24`,** not create-next-app's `^20`. Node 24 is the runtime and
vitest 5 requires `>=24`. Do not revert it.

---

## Layout

```
app/                     Next.js App Router
lib/
  epcis/                 GS1 EPCIS 2.0 as zod schemas
    primitives.ts        EPC/SGLN URIs, ISO-8601 with mandatory offset
    vocabulary.ts        CBV bizStep / disposition enums
    sensor.ts            sensorElementList + the vigil: extension
    events.ts            ObjectEvent | TransactionEvent | AssociationEvent
  db/
    schema.ts            parcels, couriers, mandates, events, verdicts
    client.ts            better-sqlite3 + Drizzle
    migrate.ts           programmatic migrations (tests, seeds)
    migrations/          generated SQL
  ledger/
    canonical.ts         canonical JSON -> sha256
    types.ts             LedgerRecord, Verdict, CheckResult
    ledger.ts            NonceLedger: check / commit / submit / verifyChain
  engine/                AXIS 1 ONLY. Pure functions, no I/O.
    thresholds.ts        every number, one source comment each; band tables
    custody.ts           disposition -> permitted bizStep (H1's policy table)
    geo.ts               turf wrappers; the only place lat/lng is inverted
    types.ts             EngineInput, RuleResult, Flag, Evidence, EngineResult
    hard.ts              H1 H2 H3 (abort, do not score)
    inconsistency.ts     I1-I14 (score) + the rule registry
    engine.ts            hard checks -> scoring -> clamp -> coverage
    fixtures.ts          shared test fixtures; never imported by a rule
    purity.test.ts       fails the build if a rule reaches I/O
  mandate/
    schema.ts            CourierMandate zod. Shape only — no crypto yet.
  agent/
    context.ts           AgentContext, the closed ToolName enum
    nodes.ts             the eight node implementations
    machine.ts           the switch driver
data/
  ledger/                nonce-ledger.jsonl (gitignored)
  db/                    vigil.db (gitignored)
```

### The EPCIS extension namespace

Mock-location flags, cell observations, WiFi scans and integrity attestations are not in the
CBV. They live under `vigil:` inside `sensorElementList`, which is where EPCIS 2.0 says user
extensions go — so "why is your custom data in a standards event?" has a spec-shaped answer.
`vigil:courierId` sits at the event root for the same reason: EPCIS models parties and
locations, not the individual who pressed the button, and that claim is *unverified* by
construction.

Everything under `vigil:` is a **signal**, never a **judgement**. Nothing there says
"fraudulent". The engine decides that by finding contradictions across signals.

`attestationSource` is required and must be one of `mocked | play-integrity | device-check`.
A simulated attestation must never be indistinguishable from a real one **in our own data** —
that is exactly the forgery we claim to detect.

---

## Commands

```bash
npm run dev          # Next dev server
npm test             # vitest, all lib/ tests
npm run typecheck    # tsc --noEmit  (run `npm run build` first: Next generates route types)
npm run lint
npm run test:coverage # engine coverage; must stay at 100% branch
npm run db:generate  # regenerate migrations after editing lib/db/schema.ts
npm run db:migrate
```

---

## Session log

### Session 1 — scaffold (complete)

46 tests passing, `tsc --noEmit` clean, eslint clean, `next build` succeeds.

**Real — implemented and tested:**

| Area | What works |
|---|---|
| `lib/epcis/` | All three event types across the five dimensions; CBV enums; the `vigil:` extension. `eventTime` and `recordTime` are separate fields; offsets are mandatory |
| `lib/ledger/` | All three paths (unseen / duplicate / reuse); `prevHash` chain; `verifyChain()` returning the break index; abort records; registry rebuild from file on construction |
| `lib/db/` | Five tables, first migration generated and applied; `createMigratedDb()` for tests |
| `agent → parse` | Full zod validation; halts on invalid rather than guessing; stamps `recordTime`; flags a client that supplied one |
| `agent → lookup` | Real Drizzle queries for parcel, courier and active mandate; unknown entity → `unknownEntityRisk: "high"` |
| `agent → verify` | **H4 only** — the ledger replay check, incl. duplicate short-circuit and reuse abort |
| `machine.ts` | Sequential driver, early exit on halt, per-node trace frames for SSE, node-error containment |

**Stubbed — returns the right shape, computes nothing:**

| Node | Marked `STUB` | What it returns today |
|---|---|---|
| `plan` | yes | `{ tools: [], planFromHeuristic: true }` |
| `verify` (partial) | yes | H1–H3 and I1–I14 not implemented; `{ score: 0, flags: [] }` |
| `fetch_history` | yes | P1–P5 not implemented; `{ score: 0, flags: [], sampleSize: 0 }` |
| `external_context` | yes | Skipped unless `plan` asked for it; placeholder summary |
| `gate` | yes | Always `accept`, `requiresCosign: false`; **does** seal a real ledger entry |
| `explain` | yes | Placeholder string built from the sealed verdict |

**No stub invents a verdict.** Every one is marked `STUB` in a comment. `gate` returning a
hardcoded `accept` is the one to be most careful with — it is real enough to write to the
ledger, so the orthogonal matrix replacing it must land before any evaluation numbers are quoted.

**Not started at all:** mandate crypto and Ed25519 co-sign; liveness/timeout paths; synthetic
data generation (`@turf/turf`, `seedrandom` not yet installed); Open-Meteo; SSE endpoint; all UI.

### Session 2 — the deterministic engine, axis 1 (complete)

174 tests passing. **`lib/engine/` is at 100% statement, branch, function and line coverage**
(`npm run test:coverage`). `tsc --noEmit` clean, eslint clean, `next build` succeeds.

**Real — implemented and tested:**

| Area | What works |
|---|---|
| `hard.ts` | H1 custody continuity, H2 scope, H3 mandate validity. All three evaluated before aborting, so an operator sees every hard failure at once. No partial accept; a hard failure suppresses I-scoring entirely |
| `inconsistency.ts` | All 14 I-rules. Each returns a structured `Flag { id, points, label, evidence[] }` where evidence names field **and** value |
| `thresholds.ts` | Every number with its derivation. Tiered rules are **band tables**, not nested ifs, so experiment 6 can move a band edge without restructuring control flow |
| `custody.ts` | H1's disposition → bizStep policy table. An unmodelled disposition imposes no constraint — H1 aborts handoffs, so it fires only where we are confident |
| `geo.ts` | turf wrappers; the single place `[lng, lat]` inversion happens. Returns `undefined` rather than an infinite speed on a zero/negative interval |
| `engine.ts` | Runs hard → scoring → clamp, and reports coverage |
| `mandate/schema.ts` | `CourierMandate` zod shape. **No crypto** |

**Design decisions worth not re-litigating:**

- **Tier exclusivity.** I4/I5 and I10/I11 are each ONE rule emitting at most one flag. A
  45-minute clock divergence scores 30, not 45. A 23 km delivery scores 40, not 60.
- **`rawScore` is kept unclamped** alongside the capped `score`, so a threshold sweep can tell
  an event that scored 100 from one that scored 385.
- **H2 fails a courier with no mandate.** An unscoped actor is not an actor with unlimited scope.
- **H3 stays silent about a missing mandate**, because H2 already reported it. Reporting it
  twice would tell an operator there are two problems when there is one.
- **I13 scores rather than aborts.** Working an hour outside your shift is a policy breach worth
  flagging; a revoked mandate is grounds for voiding the handoff, and that is H3.
- **Fixtures are built through the schema**, not cast to it, so the engine is never tested
  against data the ingest boundary would have rejected. Coordinates are real KL/Selangor points.

**Not wired in yet.** `lib/agent/nodes.ts` `verify` still returns the session-1 stub. Connecting
the engine to the agent is deliberately a separate step, so the engine was proven standalone first.

### Session 3 — wiring, then axis 2 (next)

1. Wire `runInconsistencyEngine` into the agent's `verify` node, with the caller assembling
   `EngineInput` from the DB (this is where `previous` and `referenceSites` get populated).
2. Then P1–P5 pattern scoring at `fetch_history`.

Still untouched: the gate matrix, Ed25519 co-sign, liveness/timeout paths, synthetic data
generation, SSE, all UI.

---

## Known limitations (test these, don't claim them)

Vigil catches the lazy attacker. A rooted, patched device operated by someone colluding with
the recipient is out of reach of this architecture — that is a boundary of the idea, not a
defect of the prototype, and it belongs in the write-up as a **measured** result. The same
goes for cold-start couriers with no pattern history, and for the fact that a fully controlled
device can forge `eventTime` and `recordTime` together.

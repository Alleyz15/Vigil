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

### 4. Missing is not the same as contradictory

A dropped signal (no cell service, GPS denied indoors) must never score like a signal that
disagrees with its neighbours. This distinction is the difference between S1 (spoofing) and
S6 (a tunnel), and S6 — the system correctly declining to escalate — is a demo beat.

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

### Session 2 — the deterministic engine (next)

Build `lib/engine/`: H1–H3 and I1–I14. Axis 1 only. Do not touch P1–P5, the gate matrix, or
the crypto — those are later sessions.

---

## Known limitations (test these, don't claim them)

Vigil catches the lazy attacker. A rooted, patched device operated by someone colluding with
the recipient is out of reach of this architecture — that is a boundary of the idea, not a
defect of the prototype, and it belongs in the write-up as a **measured** result. The same
goes for cold-start couriers with no pattern history, and for the fact that a fully controlled
device can forge `eventTime` and `recordTime` together.

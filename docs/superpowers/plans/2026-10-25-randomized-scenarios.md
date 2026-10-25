# Randomized Scenarios Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans or independent scoped workers, test first and commit each functional batch.

**Goal:** Add reproducible random point-to-point simulations covering I1-I16/P1-P5 input families, continuous per-courier simulated history and explicit provenance.
**Architecture:** Persist a strict optional `simulation` config separately from legacy `demoCondition`. Generate shared facts, never outcomes. Each randomized shipment receives an isolated evaluation snapshot copied from the same courier's cumulative simulation run; replaying a pending credential cannot acquire later history. Keep all authored scenarios and legacy normal bytes unchanged.
**Tech Stack:** Existing Next.js, TypeScript, Zod, seedrandom, Drizzle/SQLite, Vitest.
**Spec:** `docs/superpowers/specs/2026-10-25-randomized-scenario-design.md`, plus the user's explicit I1-I16/P1-P5 table.

## Global Constraints

- Work in the existing checkout to preserve live work and unrelated identity edits; create branch `codex/randomized-scenarios`. User explicitly authorized implementation and separate commits.
- First commit the previously verified audit fixes separately. Never include unrelated identity/layout/capture edits.
- No verdict-rule/threshold changes, no LLM decision path, no manufactured missing reference evidence.
- Confirmed coordinates/value/assignment stay fixed. Randomized scan facts can differ, independently labeled.
- Every new event is parsed through EPCIS. Generator imports no detector thresholds.
- Persist mode/seed/profile version; store sampled event snapshots before first submitted run. Same-event retries and co-sign reuse immutable bytes/context.
- No silent production restart or mutation of the user's port-3000 demo; use isolated QA until activation is requested or its process-state reset has been explained.
- Full no-model/fake-model parity and permanent authored hash remain required.

## Interfaces / Ownership

- `lib/simulation/config.ts`: `RandomSimulationConfig` Zod/type `{mode:"randomized", seed:string, version:"signals-v1"}`; seed restricted to 1-80 alphanumeric/underscore/hyphen characters. `simulationOf(row)` validates nullable persisted JSON and fails closed on corruption.
- Shipment request accepts optional `simulation`; DB `shipments.simulationJson` nullable text. Legacy omitted simulation retains old idempotency hash.
- `lib/generate/simulation/*`: pure behavior/condition sampling using named derived streams. `SimulationProvenance` includes mode, seed, version and typed sampled-condition labels. `GeneratedScenario.simulation?` carries it for read models only.
- `buildOnlineScenario` consumes persisted config; old requests retain old behavior. New mode builds random current facts plus bootstrap history. Normal and advanced mock remain compatible. Parent workbench replaces newly drawn bootstrap with the existing courier-run history after the first randomized assignment.
- Workbench owns per-courier randomized run ID, cumulative BuiltEvents/parcel references/disputes, chronological cursor and locking. Each shipment snapshots this history into its own real-agent harness; preceding sealed legs and later sealed delivery append once to the run. History at an existing evaluation remains unchanged.
- UI sends `simulation` only in random mode. `demoCondition:"mock_location"` remains the independent advanced control and legacy API contract. Random mode never promises an alert.

## Review Focus

One seed with changed inputs/version; duplicate creations and lost responses; concurrent assignments and late co-sign; corrections before delivery; failed/unknown integrity and missing authorization; correct shared GPS across dependent rules; disputed warm-up records actually visible to P2; history carrying its parcel reference and identity data.

## Tasks

- [x] 0. Verify and independently commit previous read-model/map/LLM/lifecycle audit repairs, preserving unrelated dirt.
- [x] 1. RED/GREEN strict simulation config, migration and immutable/idempotent creation. Commit `feat: persist versioned simulation requests`.
- [x] 2. RED/GREEN pure named-stream signal and history generators plus online adapter. Exercise all input families, shared GPS, missing references, schema validation and reproducibility. Document probabilities as modeling assumptions without threshold tuning. Commit `feat: generate reproducible signal and courier behavior scenarios`.
- [x] 3. RED/GREEN per-courier continuous randomized run and per-shipment evaluation snapshot, disputes, chronological ordering, concurrent/duplicate operations and unchanged co-sign payload. Expose seed/conditions/history provenance in read models. Commit `feat: preserve continuous simulated courier histories`.
- [x] 4. RED/GREEN Sender normal/random controls, seed edit/copy/regenerate, independent advanced mock; Courier/Operator provenance. Preserve creation retry body/key. Commit `feat: expose reproducible simulation controls and provenance`.
- [x] 5. Add preregistered seed manifests and offline complete-result report, including disjoint validation set, errors/coverage/ground-truth labels and no field-accuracy claims. Commit `test: add complete multi-seed simulation validation`.
- [x] 6. Run complete suite, typecheck/lint/purity/parity/hash; independent review; isolated browser baseline/random/advanced case and retry/co-sign. Update docs and commit verification separately.

## Progress

- User approved UI direction, all 21 input families, seven safety/validity requirements and separate commits.
- Prior audit changes committed separately as `1e3827d` / `a339911`; storage `474f735`, generator `8b6dd27`, journal `2210f1e`, controls `202f7df`.
- Final settled suite: 1305 passed, 8 opt-in live tests skipped; typecheck/lint passed. Authored hash/purity/model parity remain protected.
- All 30 fixed seeds completed with no errors. Full reports retain all decisions and checks, with separate development/validation courier journals.
- Independent review produced permanent RED/GREEN regressions for unknown-device enrollment, explicit overrides/device clocks, bootstrap battery continuity, stale Sender responses, recipient disputes, replay parity, failed preparation recovery and conflicting incoming references.
- Browser verified Sender seed controls, Courier identity/provenance, Operator nonzero accepted scores and co-sign sealing with unchanged event/snapshot/axes. Advanced normal-mode mock still emitted I7. Full evidence/limits are in the randomized audit closure.

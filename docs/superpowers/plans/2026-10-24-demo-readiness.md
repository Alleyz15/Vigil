# Demo Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining point-to-point presentation gaps without changing deterministic verdict policy.

**Architecture:** API mutations return an authoritative presentation snapshot; the operator read model exposes existing rule states; online demo injection adds only a mock-location signal before the unchanged engine runs. Model metadata remains advisory and fully disclosed.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Zod, Vitest, existing workbench and agent APIs.

**Spec:** `docs/superpowers/specs/2026-10-24-demo-readiness-design.md`

## Global Constraints

- Do not modify `lib/engine`, `lib/pattern`, `lib/gate`, or `lib/credential` behavior or thresholds.
- AI never changes a verdict; one configured provider falls back to the deterministic heuristic.
- Missing cell/WiFi remains missing and I1 remains `not_evaluated` for arbitrary coordinates.
- Existing dirty working-tree changes must be preserved.

## Review Focus

- A successful co-sign must visibly complete even when Server Component and API route bundles do not share memory.
- A post-co-sign explanation must use completed-signature tense.
- Hard-aborted runs must not present individual I-rules as clear.
- A demo mock-location event must trigger I7 without creating cell/WiFi evidence.
- Normal point-to-point requests that omit the demo field must remain byte-compatible in behavior.

---

### Task 1: Authoritative co-sign mutation state

**Files:** `components/demo/cosign-actions.tsx`, co-sign API routes, `components/demo/cosign-actions.test.ts`

- [ ] Add a failing client test proving a successful mutation is rendered from its response without `router.refresh()`.
- [ ] Return and adopt the selected handoff's updated co-sign model from both mutation routes.
- [ ] Run the focused tests.

### Task 2: Truthful AI state and fallback reason

**Files:** `lib/llm/prompts.ts`, `lib/llm/llm.test.ts`, `components/operator/handoff-detail-model.ts`, `components/operator/handoff-detail.test.ts`, `components/operator/handoff-detail.tsx`

- [ ] Add failing tests for supplied operator-signature prompt data and visible plan rejection copy.
- [ ] Pass credential completion into the explain prompt and plan rejection into presentation.
- [ ] Run the focused tests.

### Task 3: Complete deterministic check disclosure

**Files:** `lib/workbench/read-model.ts`, `lib/workbench/service.ts`, a focused display registry, operator detail components and tests.

- [ ] Add failing tests for all I1-I16 and P1-P5 rows with three-state status.
- [ ] Project engine and pattern rule results without recomputing them in React.
- [ ] Render a compact expandable checklist and run focused tests.

### Task 4: Point-to-point demo anomaly

**Files:** online-shipment request schema, sender model/panel, workbench online builder, route and UI tests.

- [ ] Add failing request and workbench tests for `normal` and `mock_location` demo conditions.
- [ ] Add an explicit labelled selector; inject only `mockLocationProvider: true` on delivery.
- [ ] Prove I7 triggers, I1 stays `not_evaluated`, and the normal path remains clean.

### Task 5: Documentation and verification

**Files:** `docs/BACKLOG.md`, relevant project guidance if a new lesson is established.

- [ ] Replace stale arbitrary-coordinate backlog claims with the implemented boundary and remaining limitations.
- [ ] Run focused tests, full suite, typecheck, lint, build, coverage, and browser smoke checks.
- [ ] Report exact results and leave changes uncommitted until requested.

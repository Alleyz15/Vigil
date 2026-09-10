# Session 17A Operator Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the read-only scenario viewer with an operator-first, stateful workbench whose
queue, actions, detail narrative and map are backed by the real agent, SQLite and ledger.

**Architecture:** A process-long `lib/workbench/` service owns one harness per seeded scenario and
projects its immutable verdicts plus mutable operator dispositions into typed read models. Next.js
routes call the service; React renders operational tables and a client-only Leaflet map. Operator
approval resubmits the original event with a completed credential through the existing agent.

**Tech Stack:** Next.js 16 App Router, TypeScript, zod, Drizzle SQLite, React Leaflet + OSM,
`@turf/turf`, shadcn/Base UI, Tailwind 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-10-session-17a-operator-workbench-design.md`

## Global Constraints

- Do not modify `lib/engine`, `lib/pattern`, `lib/gate`, `lib/credential`, `lib/generate` or any
  threshold.
- Never recompute a verdict in the browser or sum the two axis scores.
- Operator actions never mutate a sealed verdict.
- Scenario controls must say they load seeded synthetic data.
- Unsupported evidence gets no invented map geometry.
- Do not rerun experiments.

---

### Task 1: Operational schema and state transitions

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `lib/workbench/types.ts`
- Create: `lib/workbench/state.ts`
- Test: `lib/workbench/state.test.ts`
- Create: `lib/db/migrations/0004_*.sql` via `npm run db:generate`

**Interfaces:**
- Produce `CaseState`, `OperatorAction`, `transitionCase()` and Drizzle tables for handoff cases
  and append-only action records.

- [ ] Write failing transition tests covering queue membership, terminal removal and invalid
  transitions.
- [ ] Run the focused test and verify the missing interface fails.
- [ ] Implement the zod state/action schemas and pure transition function.
- [ ] Add Drizzle tables and generate the migration.
- [ ] Run the focused tests and migration tests.
- [ ] Commit `feat: add operator case state and action audit`.

### Task 2: Stateful workbench service

**Files:**
- Create: `lib/workbench/service.ts`
- Create: `lib/workbench/read-model.ts`
- Create: `lib/workbench/fixtures.ts`
- Test: `lib/workbench/service.test.ts`

**Interfaces:**
- Produce `getWorkbench()`, `listQueue()`, `listHandoffs()`, `getHandoff(eventId)` and
  `resolveHandoff(eventId, action)`.

- [ ] Write failing tests for priority order, auto-accept denominator/timeframe, action removal,
  byte-identical approval resubmission and sealed-verdict immutability.
- [ ] Run focused tests and verify they fail for the absent service.
- [ ] Seed process-long scenario harnesses using public generator/ingest APIs without changing the
  generator.
- [ ] Implement read models with separate axis fields and explicit provenance.
- [ ] Implement approve/reject/request-evidence/reroute action handling.
- [ ] Run focused tests and the existing agent co-sign tests.
- [ ] Commit `feat: add stateful operator workbench`.

### Task 3: Typed operator API

**Files:**
- Create: `app/api/operator/inbox/route.ts`
- Create: `app/api/operator/handoffs/route.ts`
- Create: `app/api/operator/handoffs/[eventId]/route.ts`
- Create: `app/api/operator/handoffs/[eventId]/actions/route.ts`
- Test: `app/api/operator/operator-routes.test.ts`

**Interfaces:**
- GET queue/all/detail read models; POST a strict zod action enum and return the updated case.

- [ ] Write failing route tests for successful reads, unknown ids, invalid actions and state
  conflicts.
- [ ] Verify the route tests fail because handlers are absent.
- [ ] Implement thin route handlers with no scoring logic.
- [ ] Run route tests and `npm run typecheck`.
- [ ] Commit `feat: expose operator workbench routes`.

### Task 4: Map evidence model

**Files:**
- Create: `lib/workbench/map-model.ts`
- Test: `lib/workbench/map-model.test.ts`

**Interfaces:**
- Produce `ShipmentMapModel`, route legs, contradiction features and stable evidence link ids.

- [ ] Write failing S1/S2/S3/S4/S6 geometry tests plus an unsupported-evidence test.
- [ ] Verify the tests fail for the missing mapper.
- [ ] Implement geometry extraction from generated events, mandate scope and structured evidence.
- [ ] Run focused tests and confirm unsupported fields remain unlinked.
- [ ] Commit `feat: map shipment contradictions to evidence`.

### Task 5: Operator-first application shell and lists

**Files:**
- Modify: `app/layout.tsx`, `app/globals.css`, `app/page.tsx`
- Create: `app/operator/inbox/page.tsx`, `app/operator/handoffs/page.tsx`
- Create: `components/operator/app-shell.tsx`, `inbox-table.tsx`, `handoff-table.tsx`,
  `provenance-label.tsx`, `demo-data-control.tsx`
- Modify: legacy route pages to redirect/demote demo tools

**Interfaces:**
- Render server-provided workbench data; no client score computation.

- [ ] Add component/read-model assertions for separate axes, explicit timeframe and expandable
  acceptance basis.
- [ ] Verify they fail against the old shell.
- [ ] Implement the light operator shell, inbox and all-handoffs view.
- [ ] Extend the never-summed guard to every new UI directory.
- [ ] Run focused UI/purity tests.
- [ ] Commit `feat: rebuild Vigil around the operator inbox`.

### Task 6: Correlated handoff detail and real actions

**Files:**
- Create: `app/operator/handoffs/[eventId]/page.tsx`
- Create: `components/operator/handoff-detail.tsx`, `decision-rail.tsx`, `decision-trail.tsx`,
  `operator-actions.tsx`
- Adapt: existing timeline/trace display components without changing the frozen trace contract

- [ ] Write failing interaction tests for pending copy and action requests.
- [ ] Verify expected failures.
- [ ] Implement the one-URL narrative and action mutation/refresh flow.
- [ ] Verify approval visibly adds a second run and pending states say nothing was sealed.
- [ ] Run focused tests.
- [ ] Commit `feat: add correlated handoff review and actions`.

### Task 7: Leaflet route and contradiction map

**Files:**
- Modify: `package.json`, `package-lock.json`, `app/globals.css`
- Create: `components/operator/shipment-map.tsx`, `shipment-map-client.tsx`
- Modify: handoff detail components for shared selection state

**Interfaces:**
- Render OSM route and contradiction layers, expose `selectedLinkId`, and emit
  `onSelectLink(linkId)`.

- [ ] Install `react-leaflet`, `leaflet` and `@types/leaflet`.
- [ ] Write failing selection/linkage tests around the pure controller/read model.
- [ ] Implement the client-only map, Turf vehicle interpolation and short leg-fit transition.
- [ ] Add two-way map/flag focus with reduced-motion handling.
- [ ] Run focused tests and ensure no map code enters server rendering.
- [ ] Commit `feat: add linked shipment contradiction map`.

### Task 8: Verification and recording-resolution QA

**Files:**
- Modify: `scripts/qa/capture-console.mjs`
- Create: `docs/screenshots/session-17a/*.png`
- Modify: `CLAUDE.md` Session 17A result

- [ ] Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:coverage`, and
  `npm run build`.
- [ ] Start the production-like local server and capture inbox/detail/map at 1920x1080.
- [ ] Inspect the captures once, fix all legibility/overlap issues in one batch, and recapture once.
- [ ] Record what is real, simulated, deferred and verified in `CLAUDE.md`.
- [ ] Commit `docs: record session 17a operator workbench`.

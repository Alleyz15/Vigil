# Audit Fixes Implementation Plan

> Execute the approved audit fixes with test-first changes and independent workers.

**Goal:** Close all reproduced findings in the 25 October audit, including the
defensive provider-error and rejected-credential wording cases.
**Architecture:** Keep deterministic engines and immutable event/ledger bytes
unchanged. Repair read models, lifecycle hooks, strict model-response boundaries
and recoverable evidence-to-case projections across the two existing databases.
**Tech Stack:** Existing Next.js, React, TypeScript, Zod, SQLite and Vitest.
**Spec:** `tmp/review-main/findings.md` is the reproduced audit and accepted scope.

## Constraints And Rulings

- No threshold, engine, pattern, credential or generator behavior changes.
- Preserve unrelated dirty identity/landing files; do not commit or push this turn.
- Use the current checkout: the user approved fixing this live project and its
  uncommitted work must not be lost or copied into a disconnected checkout.
- No live shipment mutation or live model call in verification; use isolated QA.
- Cross-database writes are not one atomic transaction. Evidence rows can be
  durable retryable intents, but unpublished requests must not appear actionable;
  retry must repair a missing case projection without duplicate rounds or actions.
- Courier queue adds optional `currentRun: RunView` and `state: HandoffState`
  fields. Historical attempts remain historical; the main panel uses currentRun.
- Map builder accepts optional `deliveryEvent` and `deliveryFlags` to plot the
  submitted event against the original delivery reference without recomputing risk.

## Review Focus

Missing/grouped rule states; all courier identities before submission; resolved
cases and post-evidence co-sign eligibility; corrected addresses vs recorded
references; exact retries and storage failures; strict JSON roots and contradictory
model action words; no-model/fake-model verdict parity.

## Tasks

- [x] 1. Add permanent red tests and fix hard-abort coverage, Courier current
  outcome, fleet-wide Both choices, post-evidence co-sign and closed badge wording.
- [x] 2. Add map regression tests and show actual scan plus unchanged original
  reference. Draw contradiction geometry only for real emitted spatial flags.
- [x] 3. Add red model-boundary tests, reject wrong structured roots/actions and
  handle non-Error provider rejections through normal failover/fallback.
- [x] 4. Add lifecycle tests; create recipient capabilities for newly sealed
  deliveries idempotently and project authoritative Courier state/run.
- [x] 5. Add real-route failure-injection regressions; recover persisted uploads
  and unpublished request intents without misleading success or audit divergence.
- [x] 6. Run focused/full tests, purity/parity/seeded probes, typecheck, lint and
  isolated browser verification; review final changes and update docs.

## Progress

- Audit already reproduced the old behavior with offline isolated data.
- Final verification: 1173 tests passed / 8 opt-in live-provider skips; typecheck,
  lint, purity/parity and permanent seeded hash passed. Isolated browser flow
  verified fleet selection, post-evidence co-sign, current Courier outcome,
  recipient capability and actual off-reference map evidence.
- [Durable closure report](../../audits/2026-10-25-fixes.md) records all findings,
  review follow-ups, test evidence and remaining prototype boundaries.

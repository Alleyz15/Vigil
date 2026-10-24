# Manual Dispatch and Evidence Implementation Plan

> Use test-driven implementation; execute this approved scope without another approval pause.

**Goal:** Sender creation -> Operator assignment -> Courier signature -> supporting evidence -> review.
**Architecture:** Existing workbench and agent; durable workflow sidecars in SQLite.
**Tech Stack:** Next.js App Router, React, TypeScript, Drizzle/better-sqlite3, zod, Vitest.
**Spec:** ../specs/2026-10-24-dispatch-evidence-design.md

## Global Constraints

- Preserve unrelated dirty changes. Do not commit without a separate request.
- No engine, pattern, gate, credential or threshold edits; no experiment reruns.
- All mutation responses carry their authoritative new view, not a refresh-dependent read.
- Demo actor selection is not production authentication. Original event bytes are immutable.

## Review Focus

Wrong courier/attachment access; stale identity responses; duplicate submissions; request
round races; resolved/frozen cases cannot be reopened or bypassed by upload/approval.

## Tasks

- [x] 1. RED seeded timeline probe and assignment tests. Add dispatch/evidence types, schema
  migration and storage tests: durable queue, append-only rounds, bounded validated bytes,
  idempotent retries, conflict/ownership failures. Run targeted tests before/after.
- [x] 2. Builders accept optional courierIndex, preserve default output and mandate EPC scope.
  Workbench queues new sender requests, assigns exactly once, reuses selected actor on every
  rebuild and returns selected-actor queue. Test all four couriers, H2 and old probe.
- [x] 3. Workbench request/submit/read evidence integration and routes. Add evidence_submitted
  queue state, keep original scores/event/hash, validate review eligibility, return snapshots.
  Test repeated rounds, rejection, co-sign and stale/wrong-courier requests through real routes.
- [x] 4. Courier UI: header selector, handoffs/evidence modes, real fingerprint, bounded upload,
  pending/error/receipt states. UI regression tests fail before implementation.
- [x] 5. Operator UI: assignment list; request-note form; evidence rounds/attachments; review
  controls and conditional AI sealing labels. UI regression tests fail before implementation.
- [x] 6. Sender UI: awaiting-assignment receipts/list, no delivery shortcut before assignment,
  fresh listing from API. Wire new APIs and preserve exact confirmed coordinates.
- [x] 7. Full suite/coverage, tsc, lint, build, seeded probe, guard mutation probes. Drive the
  browser create/assign/sign/request/upload/review flow; screenshot intended regions.

## Progress

- Initial inspection: current queue chooses S1's owner; builders both select index 1;
  request_evidence records state only, and approval accepts awaiting_cosignature only.
- Ruling: use local current checkout to preserve the extensive approved, uncommitted work.
- Ruling: no automatic mail/SMS or real authentication is implied by the new in-app flow.
- RED: new online creation still returned five event IDs and running=true; assignment
  methods were absent. GREEN: all four couriers assigned, their correct EPC scopes preserved.
- RED: a concurrent reject succeeded during approval. GREEN: per-handoff review lock.
- RED: regenerated S1 displayed the previous instance's request. GREEN: persisted
  workflow IDs scope reads, sequence uniqueness and submission checks; old rounds archived.
- Browser: KLCC -> Kepong, assigned CR-1002, courier signed, operator requested two rounds,
  one JPEG supplied over multipart API and one text-only reply submitted via browser.
  Operator UI showed both rounds; co-sign sealed Flag 50/0 with both signatures valid,
  13/16 and 3/5 coverage, I1 not_evaluated, I7 triggered, ledger #19 in the isolated QA run.
- QA fixture now explicitly assigns the registered-address stale-record shipment before
  correcting or delivering it. No bypass endpoint was added for screenshot capture.
- Verification: final offline suite 1034 passed / 8 live-provider skips; engine/pattern/gate
  retain 100% coverage. Production webpack build, TypeScript and ESLint passed. Permanent
  seven-scenario timeline/warm-up hash remains 09a9f7eb71bde4cd3d2b17039c7050fe82aa42315fedc6d38f15c61fceedb2a3.
  Threshold import probes were rejected naming files in db, demo, generate, shipment and
  workbench; every probe removed. QA captured all ten frames with provider explicitly none.
- No before/after pixel-equality comparison is claimed: no pre-change baseline was captured
  for this new workflow. Manual desktop checks and the existing 1920x1080 capture passed.
- First full run overlapped generation of an empty custom migration; rerun after completing
  the SQL was clean except sandbox cache-rename EPERM failures. Unsandboxed final suite passed.
- Fresh backend review reproduced and then cleared the workflow-instance finding; no
  remaining blocker in the scoped review.
- Follow-up: long timeline addresses now occupy a bounded two-line slot, with the
  full label available on hover and the time kept inside the card. Browser measurements
  confirmed containment at the default desktop viewport and at 1920x1080. Pre-commit
  verification passed 1035 tests with 8 skips, TypeScript and ESLint. The user requested
  separate functional commits; unrelated identity visual changes remain excluded.

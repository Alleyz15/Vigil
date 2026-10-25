# Randomized scenario implementation and verification

Implemented the user's I1-I16 and P1-P5 input-family specification. The generator
samples a shared story of stops, movement, handset state, receipts, proof and
independent identity records. The existing detectors compute all scores/actions.
No engine, pattern or gate thresholds changed.

## Product behavior

- Sender point-to-point controls: Normal scan / Randomized scenario; editable,
  generated and copyable seed; profile `signals-v1`. Mock location remains an
  independent checkbox inside Advanced demo controls.
- Shipment creation persists its strict configuration and idempotency identity.
  Assignment persists immutable generated facts/reference/history snapshots before
  preparing the real agent. Failed network responses retry the original request;
  responses to an edited draft cannot overwrite the current draft's result.
- One scan has one GPS observation shared by position/speed/distance checks.
  Handset clocks, server receipts, photo clocks, battery drain and physical travel
  derive from shared facts. Explicit overrides take precedence, including false.
- Radio comparisons use only existing supplied reference sites. Arbitrary online
  points retain unavailable I1; unrestricted mandates retain unavailable I13.
  Mocked attestations remain labeled. A replacement claim cannot enroll a device.
- First assignment bootstraps one courier's named randomized simulation run.
  Subsequent assignments extend it, in chronological order, with sealed events.
  Normal mode remains a separate baseline. Each handoff retains its own evaluation
  context: newer work and later complaints cannot change an old co-sign/replay.
- Courier and Operator expose saved seed, version, sampled environmental/behavior
  conditions and simulated history provenance. Sampled causes are distinguished
  from actual detector findings and do not imply real-world fraud.

All sampling distributions are **uncalibrated modeling assumptions**, documented
in `lib/generate/simulation/ASSUMPTIONS.md`. Generator code does not read detector
thresholds. A random case is not promised to produce a high score.

## Regression and review evidence

Final settled full suite: **1305 passed, 8 skipped**, 118 files passed / 2 skipped.
Skips are explicitly opt-in live-provider tests. `npm run typecheck`, `npm run lint`
and `git diff --check` passed. No live-model success is claimed.
Permanent RED/GREEN regressions cover:

- Config schema/version/seed, immutable request/snapshot storage, migration,
  legacy idempotency, exact creation retry body and delayed stale responses.
- Every input family, EPCIS parsing, shared GPS, seed reproduction independent of
  shipment UUIDs, missing references, stable handset clocks, unknown enrollment,
  explicit false overrides and cumulative bootstrap battery consumption.
- Per-courier separation, same-courier serialization/continuity, append-once
  retries, duplicate reference conflicts, complaints affecting future snapshots,
  replay restoring disputes, preparation failure recovery and late co-sign parity.
- Courier/Operator provenance and accepted nonzero-score wording. Browser QA
  exposed the latter: scores 15/25 were accepted, but the old formatter produced
  `were evaluable. .`; the fix reports the measured scores without calling them
  contradiction-free.

Authored S0-S6 timeline/warm-up SHA-256 remains:
`09a9f7eb71bde4cd3d2b17039c7050fe82aa42315fedc6d38f15c61fceedb2a3`.
The suite also retains no-model/fake-model verdict and ledger parity.

## Complete seed experiment

Run `npm run test:simulation:batch` for the fixed 20-seed development and disjoint
10-seed validation manifests. Each partition has its own continuous courier run;
its predetermined seed order is part of the context. No seed is searched for or
discarded. Error rows remain in the report and make the command exit unsuccessfully.

Committed complete output:
`docs/experiments/2026-10-25-signals-v1-validation.json`.

| Partition | Completed / total | Errors | Accept | Flag | Escalate | Freeze |
|---|---:|---:|---:|---:|---:|---:|
| Development | 20 / 20 | 0 | 3 | 10 | 1 | 6 |
| Validation | 10 / 10 | 0 | 2 | 5 | 1 | 2 |

These are computed gate actions, not automatically approved operator dispositions.
The report retains request inputs, seed/conditions/history, both measured axes,
all check statuses, flags, actual seal state and event hashes. These counts are
synthetic mechanism validation, **not field accuracy, fraud prevalence or a
calibrated false-positive estimate**. Parameters were not tuned to these counts.

## Browser verification

Used an isolated same-drive source copy on port 3012, provider `none`, and explicit
`VIGIL_SHIPMENT_DB_PATH` / `VIGIL_DB_PATH` values. No live model call or production
build was claimed. Port 3000 was not restarted or used for QA mutations.

- Confirmed normal/random controls, seed editing/copy feedback, and collapsed
  advanced controls. Courier identity switching displayed the correct work.
- Two randomized shipments for CR-1000 retained run
  `540a682f-da56-4978-819e-0800153ced6c`; their snapshots contained 35 and 40 prior
  handoffs respectively. Both saved the requested seed on Courier and Operator.
- A separate normal-mode advanced-mock submission emitted I7.
- Operator showed actual I12/P5 findings and explicit unavailable checks. Co-sign
  sealed ledger #45; pre/post API comparison confirmed identical event facts,
  simulation snapshot and scores 15/25. Both signatures became valid, attempts
  remained historical, and the recipient capability was issued.
- Saved proof images: `randomized-sender.png` and `randomized-operator.png` in the
  task visualization directory.

## Remaining prototype limits

Live journal/harness/key state remains process-local; saved configuration and
facts do not restore signing state after restart. A seed alone does not reproduce
UUIDs, keys, changed reference data or a different courier history. New runtime
behavior should be tested in a fresh workbench; an existing port-3000 process may
retain its old singleton until restarted. No silent reset was performed.

No real handset sensing or operational courier data was introduced. I1/working
hours require real registered reference/authorization inputs to become available.
Some pattern checks become unavailable when their rolling window lacks enough
history or an independent fleet baseline; the UI reports that absence.

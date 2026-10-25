# Randomized scenario: approved direction and presentation requirements

## Approved direction

The Sender demo controls have two primary choices: `Normal scan` and
`Randomized scenario`. Retain the existing `Mock location app` control under
collapsed `Advanced demo controls`, for a repeatable I7 demonstration.

Randomization generates simulated facts about the current shipment and courier
history. The existing deterministic checks calculate coverage, flags and scores.
It never chooses a desired decision or score.

## Approaches considered

1. Replace mock location entirely with randomization: a simpler surface, but
   loses the predictable exception used in the short presentation.
2. Two primary modes plus an advanced mock-location control: the recommended
   direction, accepted in conversation. Exploration and a repeatable known
   exception remain available without three competing primary choices.

## Important details to preserve in implementation

- Normal is the controlled baseline. Randomized is not an assurance of a high
  score, a realistic population model, or real-world detection accuracy.
- Environmental noise and intentional anomaly behaviors need separate provenance.
  A device reporting mock location is different from ordinary GPS drift.
- Display and persist the seed, generator/profile version, selected controls and
  realized simulated conditions. Reproduction also requires the same confirmed
  inputs and courier context. A seed alone cannot reproduce a different shipment's
  identifiers, keys or externally supplied records byte for byte.
- One shared GPS/time/device narrative feeds related rules. I10 and I11 do not
  receive separate invented GPS fixes. Per-device clock drift should remain
  coherent across events from that device.
- Recipient coordinates, sender claims, parcel value and assignment are the
  confirmed inputs. Random scan evidence never moves the reference coordinate.
- Random sampling is resolved once and stored for a new shipment. Assignment,
  refresh, double-click, retry, evidence review and co-sign must reuse it.
- A new seed applies to a new simulation, never a mutation under an existing
  event ID. Generate and confirm the seed before the creation request; preserve
  the request and its idempotency key on retry.
- Pattern checks need coherent histories, not one random scalar per P-rule.
  Within one simulation run, the same courier must retain and extend the same
  simulated history across shipments. The current per-shipment isolated warm-up
  does not satisfy this new requirement and must not be presented as already
  continuous. Keep simulated-history provenance visible; it is not real fleet
  history. A simulation-run boundary must be explicit rather than a silent reset.
- Keep all 21 check rows visible with actual `clear`, `triggered` or
  `not_evaluated` status. Twenty-one supported checks does not mean every check
  can run for every submission. Arbitrary points still lack registered cell/WiFi
  evidence; do not manufacture reference IDs. Mandate/history absence stays absent.
- Show sampled conditions separately from detected findings. A condition is a
  generator input, not proof that a rule will trigger. A flag states a signal
  contradiction, not proof that the courier committed fraud.
- Parameters require evidence or explicit `assumption` labeling and a version.
  The generator cannot import detector thresholds or tune distributions to obtain
  a preferred score, zero false positives, or a reliable alert at presentation time.
- Preserve existing S0-S6 and default normal behavior, including the permanent
  timeline hash. AI remains Plan/Explain only; no-model verdict parity still runs.

## Implementation map

Current integration points, verified in the repository:

- `components/sender/online-shipment-panel.tsx`: mode/seed controls and creation
  retry state. Existing primary controls are normal/mock location.
- `app/api/sender/online-shipments/route.ts`: strict creation validation; versioned
  configuration must be validated before storage or generation.
- `lib/shipment/store.ts`, `lib/db/schema.ts`, migrations: persist immutable
  simulation configuration and include it in creation idempotency semantics;
  legacy requests remain valid with their existing normal/mock behavior.
- `lib/shipment/build.ts`: adapts confirmed arbitrary points into generated
  timelines and warm-up history; currently seeds from shipment ID.
- `lib/generate/rng.ts`, `noise.ts`, `timeline.ts`, `scenarios/warmup.ts`:
  reuse seeded draws and schema-validated event construction. New signal/behavior
  modules belong on this side of the generator/detector boundary.
- `lib/workbench/service.ts` and read models: reuse stored draws throughout
  assignment, delivery, retry and co-sign; project provenance to detail views.

## Verification requirements

Use test-first implementation for stored configuration/idempotency, named stream
reproduction, shared signal coherence, missing evidence, immutable confirmed
coordinates, warm-up/history consistency, advanced mock control, and parity.
Verify a normal baseline, a repeatable mock-location case and multiple randomized
seeds. Do not require randomization to produce a particular decision. Confirm a
same-event courier/operator two-phase submission has unchanged event bytes.

## Seven acceptance conditions confirmed by the user

1. **Coherent signals:** normal events derive location, elapsed time, motion and
   battery from one delivery narrative. Deliberate contradictions carry a named
   simulated cause; environmental noise is allowed to produce honest false alerts.
2. **Continuous courier history:** shipment B in the same simulation run extends
   the courier history used for shipment A rather than drawing a replacement
   past. Different couriers remain distinct. Preserve the evidence/context used
   for an existing evaluation so later activity does not rewrite its explanation.
3. **Stable submissions:** persisted draws and event bytes survive refresh, an
   identical creation retry, courier retry, supporting evidence and co-sign.
   Changing the seed requires a new simulation, not rebinding an event ID.
4. **Independent generation:** sample modeled facts without reading detector
   thresholds or requesting a target score/decision. No guaranteed-high-score
   seed search in the random-mode creation path.
5. **Careful claims:** operator wording describes observed contradictions and
   review needs, not a finding that a real courier committed fraud. Simulated
   cause metadata is distinct from what the detector actually established.
6. **Honest absence:** unavailable reference sites, authorization constraints or
   history are reported as unavailable/not evaluated. Coverage is derived from
   the actual rule results. No invented reference IDs or default-low unknowns.
7. **Complete batch evidence:** choose and record a seed manifest before the
   test batch, retain every result including errors, and use a disjoint manifest
   for independent validation. Report denominators, coverage, labeled synthetic
   ground truth and failures. Do not report synthetic test rates as measured
   field accuracy. Do not tune noise parameters to improve those rates.

Implemented on 25 October 2026. Distribution assumptions live in
`lib/generate/simulation/ASSUMPTIONS.md`; complete fixed-manifest results and
verification limits are recorded in `docs/audits/2026-10-25-randomized-scenarios.md`.
The implementation preserves separate environmental/behavior labels and immutable
per-shipment snapshots within the same courier's process-local simulation journal.

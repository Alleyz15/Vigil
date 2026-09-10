# Session 17A Operator Workbench Design

## Job and audience

Vigil's primary user is an operations reviewer processing handoffs that need attention. The
interface is an **operate** surface: the first screen is a priority queue, not an analytics
dashboard, scenario browser or courier-monitoring product.

## Product structure

- `/` redirects to `/operator/inbox`.
- `/operator/inbox` lists actionable cases: flagged, awaiting co-signature and timed out.
- `/operator/handoffs` lists every handoff, including automatic accepts and their gate basis.
- `/operator/handoffs/[eventId]` is the single correlated narrative: event, map, evidence, both
  axes, gate, credential, trace, seal and ledger sequence.
- `/demo/gate` retains the orthogonal-gate explorer as a demo tool outside product navigation.
- Legacy `/timeline`, `/stream` and `/gate` routes redirect to the new surfaces.
- The scenario control is labelled "Seeded synthetic shipment" and stays in the shell corner.

## Operational model

A process-long workbench owns real migrated SQLite databases and hash-chained ledgers. It runs
generated scenarios once, retains their contexts and records operator actions. Requests read that
state; they never regenerate and destroy a scenario.

The deterministic verdict and the operator disposition remain separate. Approving a pending
co-signature completes the sidecar credential and resubmits the byte-identical event through
`runAgent`. Rejecting, requesting evidence or proposing a reroute records an operational action
without updating a sealed verdict.

## Operator surfaces

The inbox is a dense table ordered by explicit operational priority, then age. Each row shows
parcel, courier, state, reason, age and the two axis scores separately. Terminal actions remove a
case; requesting evidence moves it out of the active queue.

All Handoffs leads with a sentence whose numerator, denominator and fixed demo timeframe are
explicit. Each automatic accept expands to its sealed gate basis and evidence coverage.

The detail page uses a two-column first viewport: route/contradiction map on the left and sticky
decision/action rail on the right. The shipment timeline and frozen eight-node trace follow below.
Pending cases state "nothing was sealed" before any score or action.

## Map contract

The server produces typed route and contradiction geometry from measured coordinate fields only.
Unsupported evidence remains unlinked. React Leaflet renders OSM tiles; Turf interpolates the
vehicle position. Selecting a leg performs a short functional viewport transition. Map features
and structured flags share stable link IDs for two-way focus.

## Provenance

Every material value carries a compact source state: `synthetic`, `mocked`, `derived`,
`external`, `model`, `fallback`, `sealed`, `evaluated`, `cold start`, `pending` or `unavailable`.
Weather repeats the approximately 9 km regional-resolution qualification.

## Constraints

- No changes to engine, pattern, gate, credential, generator or thresholds.
- No browser verdict computation and no arithmetic combining the axes.
- No authentication. Hardcoded identities are explicitly labelled simulated; signatures are real.
- Motion remains limited to the existing approved surfaces. Map camera motion is short and
  functional. The gate explorer and trace sequence receive no decorative animation.
- Desktop operator layout targets 1920x1080. The inbox and detail remain usable at narrower widths.

## Session boundary

17A ships the operator workbench, inbox, all-handoffs list, correlated detail, real operator
actions, map and provenance. Courier and recipient entry routes, rejected-alternative audit and
browser ledger verification remain Session 17B.

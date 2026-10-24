# Vigil Product Backlog

## Sender map: arbitrary points implemented

The registered-address form remains available, and the point-to-point form now
accepts a coordinate a sender explicitly confirms inside the service boundary.

- A map click or geocoder result is only a pending point until the sender confirms
  it as collection or delivery. Search and reverse lookup label the coordinate;
  neither moves or snaps it.
- Distinguish cached real geocoded address coordinates from derived synthetic
  cell and WiFi references. Mechanism evidence is not real-world observation.
- Evaluate expansion before choosing a count: current Nominatim usage limits
  and acquisition time, reference-site derivation, k=3 depth partition results
  measured on 24 addresses / 552 routes, and seeded byte reproducibility.
  Preserve a baseline and explicitly account for any dataset-version changes.
  No time estimate or zero-risk promise is established.

## Open reservations: arbitrary-coordinate reference evidence

- Arbitrary coordinates intentionally leave I1 `not_evaluated` without registered
  reference evidence, with the actual reason visible. The simulator never invents
  cell evidence or WiFi IDs to hide that absence.
- Display coverage from each actual result, never a fixed check count.
- The sender surface has an explicit demo-only mock-location condition. It sets
  the handset's reported mock-provider fact, which I7 evaluates independently;
  it does not make I1 evaluable and does not set a verdict directly.
- API geocoding and experiment generation are distinct paths. Keep experiment
  generation on fixed cached inputs; geocoding must not enter pure verdict rules.

## Recipient confirmation: implemented boundaries

- Render `detail.recipientConfirmation` in the operator handoff detail only
  when the read model supplies it. The entry opens `/confirm/[token]`; never
  expose recipient capability tokens through a list endpoint or global role
  switcher.
- Keep pending or unsealed handoffs honest: they have no recipient capability
  link because confirmations are issued only for sealed delivery legs.
- Preserve the two recipient-authored answers exactly: `received` and
  `not_received`. `no_response` is a system-observed expiry outcome and must
  never be accepted or displayed as a recipient action.
- `tokenMessage()` now describes a stored `no_response` as a closed confirmation
  window without a recipient answer. Expiry never claims the parcel was received.

## Mutation state and model failover: implemented

- Courier submission returns its updated workspace, including the acting identity.
  Sender corrections return the updated shipment row. Clients adopt those mutation
  responses and discard any initial queue read that began before the mutation.
- Online sender rows project the saved correction while preserving the original
  reference point and address.
- Gemini Plan/Explain retries once with configured Haiku, validating each attempt
  as a whole. Both failure reasons remain visible if structured fallback is needed.
  Provider `none` disables all model calls for deterministic QA.

## Cached-address creation list refresh: implemented

- Creation now returns the authoritative pending-shipment list. Both sender forms
  publish that snapshot and `SenderShipments` adopts it directly, without depending
  on a Server Component refresh. A delayed initial read cannot erase the new row.
- New requests await operator assignment before courier scans are available.

## Open: closed-case credential wording

- A rejected handoff correctly closes review and leaves its incomplete credential
  unsealed, but the decision panel still labels that credential `pending`. Distinguish
  the closed operator disposition from credential completeness; do not imply the
  rejected case is still awaiting approval.

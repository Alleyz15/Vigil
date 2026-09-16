# Vigil Product Backlog

## Sender map: cached locations only

The former arbitrary Kuala Lumpur pin / runtime geocoding plan is deferred.
Keep registered Klang Valley locations; do not expand the dataset yet.

- Current map selects explicit registered points, not arbitrary background clicks.
  If background-click snapping is added, show the proposed registered address
  and require confirmation before changing the form; never silently substitute.
- Distinguish cached real geocoded address coordinates from derived synthetic
  cell and WiFi references. Mechanism evidence is not real-world observation.
- Evaluate expansion before choosing a count: current Nominatim usage limits
  and acquisition time, reference-site derivation, k=3 depth partition results
  measured on 24 addresses / 552 routes, and seeded byte reproducibility.
  Preserve a baseline and explicitly account for any dataset-version changes.
  No time estimate or zero-risk promise is established.

## Open reservations: arbitrary coordinates

- Arbitrary coordinates remain out of scope. If introduced later, I1 must be
  `not_evaluated` without cached reference evidence, with its actual reason
  visible. Never generate synthetic cell evidence for arbitrary coordinates
  and feed it into I1 to hide missing evidence.
- Display coverage from each actual result, never a fixed check count.
- The S1 GPS-spoof demonstration may not transfer to user-created arbitrary
  locations without reference evidence. Resolve that detection tradeoff before
  implementation; this is not merely a map-component change.
- API geocoding and experiment generation are distinct paths. Keep experiment
  generation on fixed cached inputs; geocoding must not enter pure verdict rules.

## After Figma: recipient confirmation discoverability and state wording

- Render `detail.recipientConfirmation` in the operator handoff detail only
  when the read model supplies it. The entry opens `/confirm/[token]`; never
  expose recipient capability tokens through a list endpoint or global role
  switcher.
- Keep pending or unsealed handoffs honest: they have no recipient capability
  link because confirmations are issued only for sealed delivery legs.
- Preserve the two recipient-authored answers exactly: `received` and
  `not_received`. `no_response` is a system-observed expiry outcome and must
  never be accepted or displayed as a recipient action.
- Correct `tokenMessage()` for an answered row whose answer is `no_response`.
  Today it falls through to the positive `received` wording after
  `expireConfirmations()` writes `no_response`; the UI must instead state that
  the window closed without an answer.

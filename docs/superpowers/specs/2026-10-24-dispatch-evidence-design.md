# Manual Dispatch and Supporting Evidence

Approved in chat: Operator manually assigns sender-created shipments; a demo courier
selector changes the acting courier; requested evidence is submitted as text plus
JPEG/PNG/PDF attachments, then reviewed by the operator.

## Workflow

- New online and registered-address sender requests wait for assignment. No EPCIS run
  is created before assignment. Existing and seeded scenarios retain their assignments.
- Operator sees sender/delivery references, simulated depots, value and available demo
  couriers. Assign once, before signing; no silent reassignment or automatic scheduling.
- Each courier sees only their own prepared scans and evidence requests. The selector is
  explicitly a demo identity switch, not authentication. The selected handoff's actual
  fingerprint is displayed (historical isolated worlds can contain different keys for one ID).
- Request evidence requires a non-empty operator note. Each request creates a separate
  round. Courier submits a non-empty explanation and up to three JPEG/PNG/PDF files,
  maximum 5 MiB each. An in-app request list is the delivery mechanism, not SMS/email.
- Submission returns the authoritative updated workspace and moves the case back into
  the operator queue as evidence_submitted. Operator can request another round, reject,
  escalate, or co-sign an otherwise eligible pending credential. Approval reuses the
  original event and agent path; a hard stop is not overridable.
- Original rules, scores, event bytes and sealed records never change because of an
  attachment. Attachments are unverified supporting material, not fresh sensor inputs.

## Storage and Safety

Use SQLite/Drizzle for pending dispatches, evidence rounds, attachment metadata and bytes.
Keep uploads outside public/. Server checks size, extension, MIME and byte signature;
serve by opaque attachment ID with scope checks, nosniff and attachment disposition.
Store SHA-256 for integrity, not truth. No claim of malware scanning or photo authenticity.
Evidence is append-only per round; failed uploads write no submission. Duplicate retries
use a submission ID and must not append twice or resurrect a resolved case.

Current workflow/harnesses and keys are process-local. Durable pending dispatches can be
assigned after restart; previously assigned live workflows cannot be silently regenerated.
Evidence survives as stored material but cannot revive a lost harness. Say so in the UI.

## Alternatives and Scope

Manual operator assignment was chosen over distance-based auto-dispatch: no live fleet
position/availability exists. Inline evidence view in the existing courier workspace was
chosen over a new standalone product. Rescanning, reassignment, real login, external
notifications, model file analysis and automatic evidence acceptance are excluded.

Engine, pattern, gate, credential and thresholds are unchanged. Builders gain optional
courier selection with their old defaults preserved; seeded timeline/warmup probe must
remain identical. AI Explain remains post-seal only. Pending UI must not claim sealed hashes.

# Vigil

An agentic handoff trust verifier for last-mile logistics. HackAI 2026,
Track 02: Secure Logistics & Digital Trust.

Vigil does not prove a delivery happened. It checks whether claims agree and
whether a courier's accumulated behaviour contradicts otherwise plausible events.
This repository is a synthetic-data prototype, not a production fraud detector.

## Run locally

Use Node.js 24 and npm. The native SQLite dependency requires a supported native
binary or a working native build toolchain.

```bash
npm ci
npm run dev
```

Open http://localhost:3000. If that port is already occupied, use
`npm run dev -- --port 3001` without stopping the existing process.

The seeded demo creates its own migrated, in-memory SQLite databases and temporary
hash-chained ledger files. No manual database seed or API key is required to explore
the core workflow. Demo state is process-local; a restart regenerates it.
For the separate file-backed database configuration, see `.env.example` and
`npm run db:migrate`; it is not a production persistence setup for the workbench.

## Demo entry points

| Page | What it shows |
|---|---|
| `/sender` | Create a shipment using registered Klang Valley locations; preserve the original reference when correcting an address |
| `/courier` | Submit an unsubmitted courier draft through the real agent |
| `/operator/inbox` | Handoffs needing operator attention |
| `/operator/handoffs` | All handoffs, including accepted work; open a row for its actual evidence and available actions |
| `/demo/gate` | Original two-axis chart, with observations separate from illustrative reference points |
| `/verify` | Browser-side verification of raw ledger bytes and a browser-copy tamper demonstration |
| `/demo/models` | Archived cross-vendor decisions, not new live model calls |
| `/demo/injection` | Archived adversarial evidence and per-row transitions |
| `/demo/cosign` | Constitutive courier/operator signature demonstration |

Recipient confirmation is `/confirm/[token]`, reached through a capability link
in an eligible handoff's detail page, not a global recipient account or token list.
Sender's courier-delivery control is explicitly a demo proxy operation, not a
claim that a sender performs a courier's product role.

## Architecture

- Next.js App Router, TypeScript, Tailwind and shadcn/ui; SQLite with
  better-sqlite3 and Drizzle; append-only JSONL ledgers; Node crypto for Ed25519.
- The eight-node agent permits an LLM only in `plan` and `explain`. Planning
  selects zero to two optional tools from a closed four-tool enum. Explanation
  follows sealing and is validated as a whole, with deterministic fallback.
- The deterministic single-event rules I1-I16 and pattern rules P1-P5 produce
  separate axes. Only `gate` joins them; they are never summed.
- A required operator signature is constitutive. Missing co-signature seals
  nothing; an invalid credential is attack evidence. Mandate limits remain binding.
- The ledger is authoritative; database verdict rows are queryable projections.
  Tests enforce pure verdict paths, generator/threshold separation, and model parity.

## Results and provenance

The source of truth is [RESULTS.md](docs/RESULTS.md), with assumptions and dataset
versions in [DATASET.md](docs/DATASET.md). These are synthetic measurements, not
estimates of deployed performance.

| Measurement | Archived result | Scope |
|---|---|---|
| E2 detection | Seven modelled classes, each 12/12 detected | Session 16, `ef4c2f0`; attacks the detector was designed for |
| E3 operator alerts | 0.4% / 0.9% / 2.2% per leg at noise levels 1 / 2 / 3 | Session 16, same archive; modelled environmental and identity noise |
| E1 collusion boundary | Level 4 completed 40 attempts undetected in each of 12 runs | Session 9, `1d6cde6`; no later environmental noise or I15/I16 |
| E4a vendor agreement | 33.3% on S1 and S6 despite internal 5/5 stability | Session 14, `7a7c1d7`; three fixed fixtures |

E4/E5 measurements name `gemini-3.5-flash-lite`,
`claude-haiku-4-5-20251001` and `qwen2.5:7b` where applicable. Historical model
responses are archived, not guaranteed to repeat on another online call.
`npm run experiments` and individual experiment scripts replace their CSV outputs;
read the archive before treating a current-code rerun as the same experiment.

## Checks and optional providers

```bash
npm test -- --maxWorkers=4
npm run typecheck
npm run lint
npm run build
```

No rolling test total is maintained here. Live-provider checks are separate:
configure `.env` using `.env.example`, supply the relevant provider keys and a
running Ollama instance with the configured model, then run `npm run test:llm:live`.
Unconfigured live checks skip; hosted calls may incur costs. The preflight CSV
records provider operations, not the number of tests that passed.

## Limitations

- Sender locations may be confirmed anywhere inside the four-unit service area;
  search and reverse lookup only label a point and never move it. This is not road
  navigation or live parcel tracking.
- At an arbitrary point, a real handset's cell ID/BSSIDs may be absent from the
  demo registry. The simulator does not invent those IDs, so its event carries no
  cell/WiFi observations and I1 is honestly `not_evaluated`.
- Cached address coordinates were geocoded from real locations. Cell/WiFi reference
  signals, device attestations and logistics observations are simulated evidence,
  not field measurements. Signatures and their verification are real cryptography.
- E1's measured level-4 boundary requires a patched build, forged radio context,
  synthesised motion/battery signals and recipient collusion, not root access alone.
- Missing checks are `not_evaluated`, not clean evidence; coverage is result-derived.
  A hub losing its departure scan can still be narrowly and consistently over-refused.
- Four injection pairs per model cannot rank steerability. One Qwen pair crossed
  `flag` to `accept`; the explain guard saw no live contradictory explanation in that run.
- Demo identities and signing-key handling are not production authentication or key
  custody. Production would require independently collected reference evidence and
  secure key management. Weather is optional explanation context, never verdict input.

See [CLAUDE.md](CLAUDE.md) for architectural constraints, known limitations and
historical session records. Arbitrary sender coordinates remain deferred.

## AI tools and media disclosure

Development used AI assistance from Codex and Claude; Claude co-authorship is
recorded in the Git history. Runtime/experiment providers are separate from those
development tools and do not determine production verdicts. The existing hero video
is AI-generated, not real logistics footage. Its generation-service attribution and
submission-use permission remain unconfirmed; this disclosure is not a licensed
submission asset list or an assertion that the video is cleared for submission.

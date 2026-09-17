# Strict visual comparisons

Use an isolated development process: console capture creates shipments and
approves a co-signature. Never run the fixture against a user's active demo.

For each before/after run, start a fresh server with the same QA-only key seed.
In PowerShell, from the project root:

```powershell
$env:VIGIL_QA = '1'
$env:VIGIL_QA_KEY_SEED = 'route-group-v1'
$env:NODE_OPTIONS = '--import=./scripts/qa/fixed-keys.mjs'
npm run dev -- --port 3012
```

The preload is deliberately absent from application imports and normal npm
scripts. Its predictable keys are test fixtures, never production keys. It
requires explicit QA activation and rejects production processes. Clear these
three variables before launching normal development, tests or builds.

In a separate terminal, capture into a new output directory:

```powershell
$env:VIGIL_BASE_URL = 'http://localhost:3012'
$env:VIGIL_QA_OUT = "$env:TEMP/vigil-strict/before-console"
$env:VIGIL_QA_TILE_CACHE = "$env:TEMP/vigil-strict/tiles"
$env:VIGIL_QA_TILE_MODE = 'record'
npm run qa:capture
$env:VIGIL_QA_OUT = "$env:TEMP/vigil-strict/before-landing"
npm run qa:capture:landing
```

Repeat on the after version with the same seed and fresh server, changing only
the output directories to `after-console` and `after-landing`, and set
`VIGIL_QA_TILE_MODE` to `replay`. Do not rerun the
stateful console sequence in an already-approved process.

```powershell
node scripts/qa/compare-frames.mjs "$env:TEMP/vigil-strict/before-console" "$env:TEMP/vigil-strict/after-console"
node scripts/qa/compare-frames.mjs "$env:TEMP/vigil-strict/before-landing" "$env:TEMP/vigil-strict/after-landing"
```

Console stills force reduced motion before navigation, await fonts, map loading,
tiles and animations, and require three consecutive identical screenshots.
Each PNG has a JSON sidecar recording the actual readiness state and visible
fingerprints. There are no masks or excluded pixel regions. Comparison fails
on any changed pixel, image dimensions, missing frame or extra frame.

The tile fixture records actual OpenStreetMap PNG responses once, outside the
repository. It includes intermediate camera requests even when Leaflet cancels
them, because those requests can occur again on replay. Known responses are
replayed verbatim. Replay fails on missing assets rather than consulting the
live tile service. Sidecars record tile URLs, response hashes and SVG paths:
the same URL can return a different live image, even with a settled camera.
This is browser QA interception only; application map URLs and behaviour remain
unchanged. Preserve the tile fixture with the paired screenshots when archiving
a comparison. Do not treat a fixture's map as a live geography observation.

Landing motion checks remain motion-enabled where required; the existing script
pauses video and checks each captured pipeline phase. The reduced/narrow groups
retain their separate checks. Output overrides do not alter those checks.

Shell presence is structural (`app/(console)` versus `app/(standalone)`).
Remaining pathname checks for navigation/role highlighting, headings, the
Injection evidence label and preserving the selected URL are presentation
logic; they do not decide whether a shell exists.

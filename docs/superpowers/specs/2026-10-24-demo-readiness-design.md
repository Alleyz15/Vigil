# Demo Readiness Design

## Intent

Make the three-minute point-to-point demo truthful and resilient: API mutations must update the
co-sign surface immediately, model fallbacks and final credential state must be explicit, the
operator must be able to inspect every deterministic check, and a demo-only point-to-point anomaly
must exercise an existing rule without inventing reference evidence.

## Approved Scope

- Adopt authoritative co-sign mutation responses instead of relying on a cross-bundle refresh.
- Tell the explanation model whether the required operator signature was actually supplied.
- Show the exact plan rejection reason when deterministic fallback ran.
- Project and render I1-I16 and P1-P5 as triggered, clear, or not evaluated.
- Add a clearly labelled point-to-point demo control for a mock-location signal; keep the normal
  path unchanged and do not fabricate cell or WiFi identifiers.
- Update stale arbitrary-coordinate backlog text to match the implemented product.
- Preserve the deterministic engine, pattern engine, gate, thresholds, EPCIS timeline shape, and
  explicit single-provider runtime policy.

## Non-Goals

- No automatic Gemini-to-Anthropic failover.
- No new verdict rule, score, threshold, or model-authored decision.
- No road routing or real carrier telemetry.
- No claim that synthetic results estimate production accuracy.

## Approach

The co-sign endpoint returns enough data for the client to render the new phase immediately. The
read model projects the rule states already produced by the two deterministic engines; presentation
labels live in one display registry and never recompute results. The online shipment request carries
an explicit demo condition that changes only the delivery signal bundle before the existing engine
runs. Every behavior change is test-first.

/**
 * How an evidence value is printed, in one place.
 *
 * Every flag carries `{ field, value }` pairs naming the signal that
 * contradicted another, and `value` is genuinely `unknown` — a number, a
 * string, a boolean, or a structured reading like a GPS point.
 *
 * THE BUG THIS EXISTS TO PREVENT. A view that interpolates the value directly,
 * or calls `String(value)`, renders an object as `[object Object]`. The row
 * then claims to show what contradicted what and shows nothing at all, which
 * is worse than omitting it: the operator sees a populated evidence line and
 * has no way to know it is empty. Session 19's co-sign split screen shipped
 * exactly that for `sensor.gps.point`, and it was visible only in a rendered
 * frame.
 *
 * There were three near-copies of this before it moved here — one private to
 * the timeline, one inline in the handoff detail, and the broken one. Printing
 * evidence is not a per-view decision.
 */
export function formatEvidenceValue(value: unknown): string {
  if (value === null || value === undefined) return "—";

  // A coordinate is the common structured case and the one that matters on
  // screen. Printed to 5 decimal places, which is roughly a metre — enough to
  // read a spoof against a tower, and honest about not being more precise.
  const point = asPoint(value);
  if (point) {
    const accuracy = accuracyOf(value);
    return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}${accuracy}`;
  }

  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * BOTH SPELLINGS, because the codebase genuinely uses both.
 *
 * `lib/engine/geo.ts` works in `lat`/`lng`, while the EPCIS sensor extension
 * stores `latitude`/`longitude` — and it is the sensor reading that reaches an
 * evidence row. Checking only the short form is how this shipped printing a raw
 * JSON blob for the one value the fraud case turns on. Accepting both is not
 * leniency; it is the actual shape of the data.
 */
function asPoint(value: unknown): { lat: number; lng: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;

  const lat = candidate.lat ?? candidate.latitude;
  const lng = candidate.lng ?? candidate.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return null;

  return { lat, lng };
}

/** A fix without its uncertainty is a claim of precision the reading does not make. */
function accuracyOf(value: unknown): string {
  const candidate = value as Record<string, unknown>;
  const accuracy = candidate.accuracyMeters;
  return typeof accuracy === "number" ? ` ±${accuracy} m` : "";
}

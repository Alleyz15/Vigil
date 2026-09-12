import { describe, expect, it } from "vitest";
import { formatEvidenceValue } from "./evidence";

describe("evidence values are printed, never stringified into nothing", () => {
  /**
   * THE REGRESSION. `String({lat, lng})` is "[object Object]", so the row
   * claims to show the signal that contradicted another and shows nothing.
   * Worse than omitting it: a populated-looking line the reader cannot tell is
   * empty. It shipped on the co-sign split screen and was visible only in a
   * rendered frame.
   */
  it("never renders an object as [object Object]", () => {
    for (const value of [{ lat: 3.1, lng: 101.6 }, { a: 1 }, [1, 2], { nested: { x: 1 } }]) {
      expect(formatEvidenceValue(value)).not.toContain("[object Object]");
    }
  });

  it("prints a coordinate as a coordinate, to about a metre", () => {
    expect(formatEvidenceValue({ lat: 3.148912, lng: 101.71234 })).toBe("3.14891, 101.71234");
  });

  /**
   * Chosen off a float boundary deliberately. My first version of this test
   * asserted `101.712345 -> 101.71235`, which is the arithmetic a person does
   * in their head; the nearest double to that input sits just below the
   * midpoint, so it truncates to ...34. The code was right and the assertion
   * was wrong — rule 1f's second failure mode, caught the same session it was
   * written down.
   */
  it("rounds a value that is unambiguously above the midpoint", () => {
    expect(formatEvidenceValue({ lat: 3.1489167, lng: 101.7123456 })).toBe("3.14892, 101.71235");
  });

  /**
   * THE SECOND HALF OF THE SAME BUG. The first fix only matched `lat`/`lng`,
   * but an evidence row carries the EPCIS sensor reading, which spells them
   * `latitude`/`longitude` — so the GPS point the whole S1 case turns on still
   * printed as a raw JSON blob. Fixed once the RENDERED frame was looked at,
   * not when the test went green.
   */
  it("reads the sensor spelling, which is the one that reaches an evidence row", () => {
    expect(
      formatEvidenceValue({
        latitude: 3.170146242025193,
        longitude: 101.65239748508077,
        accuracyMeters: 16,
      }),
    ).toBe("3.17015, 101.65240 ±16 m");
  });

  it("omits an accuracy it was not given rather than implying one", () => {
    expect(formatEvidenceValue({ latitude: 3.17, longitude: 101.65 })).toBe("3.17000, 101.65000");
  });

  it("falls back to JSON for structures that are not points", () => {
    expect(formatEvidenceValue({ cellId: "502-12-4515-90015" })).toBe(
      '{"cellId":"502-12-4515-90015"}',
    );
  });

  it("leaves primitives readable, without quoting strings", () => {
    expect(formatEvidenceValue("502-12-4515-90015")).toBe("502-12-4515-90015");
    expect(formatEvidenceValue(true)).toBe("true");
    expect(formatEvidenceValue(0)).toBe("0");
  });

  /** Absence is shown as absence, not as the string "null". */
  it("marks a missing value rather than printing null", () => {
    expect(formatEvidenceValue(null)).toBe("—");
    expect(formatEvidenceValue(undefined)).toBe("—");
  });

  /**
   * A partial coordinate is NOT a coordinate. Printing `3.1, undefined` would
   * assert a position from half a reading.
   */
  it("does not treat a half-formed point as a point", () => {
    expect(formatEvidenceValue({ lat: 3.1 })).toBe('{"lat":3.1}');
    expect(formatEvidenceValue({ lat: 3.1, lng: "101.6" })).toBe('{"lat":3.1,"lng":"101.6"}');
  });
});

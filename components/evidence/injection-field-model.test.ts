import { describe, expect, it } from "vitest";
import { readInjection } from "@/lib/evidence/e4";
import { filterInjectionFields, injectionMovementLabel } from "./injection-field-model";

describe("Injection field filtering", () => {
  it("shows the complete measured data for all fields", () => {
    const report = readInjection();
    const selected = filterInjectionFields(report, null);
    expect(selected.payloads).toEqual(report.payloads);
    expect(selected.rows).toEqual(report.rows);
  });

  it("matches each payload to its three real vendor rows without changing the report", () => {
    const report = readInjection();
    const before = JSON.stringify(report);
    for (const payload of report.payloads) {
      const selected = filterInjectionFields(report, payload.surface);
      expect(selected.payloads).toEqual([payload]);
      expect(selected.rows).toHaveLength(3);
      expect(selected.rows.every(row => row.payloadId === payload.payloadId)).toBe(true);
    }
    expect(JSON.stringify(report)).toBe(before);
  });

  it("does not invent results for an unknown field", () => {
    expect(filterInjectionFields(readInjection(), "unknown")).toEqual({ payloads: [], rows: [] });
  });

  it("distinguishes a crossed accept boundary from other changes", () => {
    const rows = readInjection().rows;
    const crossed = rows.find(row => row.provider === "ollama" && row.surface === "photo_filename")!;
    expect(injectionMovementLabel(crossed)).toBe("Reached accept");
    expect(injectionMovementLabel(rows.find(row => row.changed && row.injectedDecision !== "accept")!)).toBe("Changed");
    expect(injectionMovementLabel(rows.find(row => !row.changed)!)).toBe("Unchanged");
  });
});

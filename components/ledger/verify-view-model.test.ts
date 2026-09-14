import { describe, expect, it } from "vitest";
import { compactLedgerPreview, ledgerPreview, tamperLineIndex } from "./verify-view-model";

describe("tamperLineIndex", () => {
  it("uses record 2 when the ledger is long enough", () => {
    expect(tamperLineIndex(19)).toBe(2);
  });

  it("stays within a short ledger", () => {
    expect(tamperLineIndex(2)).toBe(1);
    expect(tamperLineIndex(0)).toBe(0);
  });
});

describe("ledgerPreview", () => {
  it("returns the first two non-empty raw records", () => {
    expect(ledgerPreview("first\n\nsecond\nthird\n")).toEqual(["first", "second"]);
  });

  it("compacts long records without inventing content", () => {
    expect(compactLedgerPreview("123456789\nsecond\n", 2, 6)).toEqual([
      "123...",
      "second",
    ]);
  });
});

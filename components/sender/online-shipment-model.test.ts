import { describe, expect, it } from "vitest";
import { canConfirm, newIdempotencyKey, SLOT_LABEL, submitRefusal, type PickedPoint } from "./online-shipment-model";

const inside: PickedPoint = { latitude: 3.139, longitude: 101.6869, inside: true, claim: null };
const outside: PickedPoint = { latitude: 4.5975, longitude: 101.0901, inside: false, claim: null };

describe("confirming a clicked point", () => {
  it("accepts a point inside the area, with or without an address claim", () => {
    expect(canConfirm(inside)).toBe(true);
    expect(canConfirm({ ...inside, claim: "Block B lobby" })).toBe(true);
  });

  /**
   * An outside point cannot be confirmed — but the surface answers it with the
   * reason and the covered units rather than a disabled control, so this is the
   * only place the refusal is a boolean at all.
   */
  it("refuses a point outside the area, and refuses nothing at all before a click", () => {
    expect(canConfirm(outside)).toBe(false);
    expect(canConfirm(null)).toBe(false);
  });
});

describe("what still has to be done before a shipment can be sent", () => {
  it("names the missing step rather than staying silent", () => {
    expect(submitRefusal(null, null, 18000, "+60119990007")).toMatch(/collection point/i);
    expect(submitRefusal(inside, null, 18000, "+60119990007")).toMatch(/delivery point/i);
  });

  it("refuses the same coordinate at both ends", () => {
    expect(submitRefusal(inside, { ...inside }, 18000, "+60119990007")).toMatch(/same coordinate/);
  });

  it("requires a value and an independently verified channel", () => {
    const other: PickedPoint = { ...inside, latitude: 3.16 };
    expect(submitRefusal(inside, other, 0, "+60119990007")).toMatch(/value above zero/);
    expect(submitRefusal(inside, other, 18000, "  ")).toMatch(/I15/);
  });

  it("is silent when there is nothing left to do", () => {
    const other: PickedPoint = { ...inside, latitude: 3.16 };
    expect(submitRefusal(inside, other, 18000, "+60119990007")).toBeNull();
  });
});

describe("the idempotency key", () => {
  /**
   * NOT DERIVED FROM THE COORDINATES. Two parcels confirmed at one door are two
   * parcels; deriving the key from the points would silently collapse them into
   * one, which is the failure the three-state create exists to avoid.
   */
  it("is minted, not derived from the points", () => {
    const first = newIdempotencyKey(() => "a");
    const second = newIdempotencyKey(() => "b");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^sender-online-/);
  });
});

describe("the two slots", () => {
  it("are labelled for a person, not named after the API field", () => {
    expect(SLOT_LABEL.origin).toBe("Collection point");
    expect(SLOT_LABEL.destination).toBe("Delivery point");
  });
});

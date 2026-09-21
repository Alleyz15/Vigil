import { describe, expect, it } from "vitest";
import {
  bodyPoint,
  canConfirm,
  newIdempotencyKey,
  SLOT_LABEL,
  submitRefusal,
  withReverseLabel,
  type PickedPoint,
} from "./online-shipment-model";

const inside: PickedPoint = { latitude: 3.139, longitude: 101.6869, inside: true, claim: null, resolved: null };
const outside: PickedPoint = { latitude: 4.5975, longitude: 101.0901, inside: false, claim: null, resolved: null };

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

describe("a reverse lookup labels the pin and never moves it", () => {
  const clicked: PickedPoint = { latitude: 3.139013, longitude: 101.686855, inside: true, claim: null, resolved: null };

  /** BIT-IDENTICAL: the coordinate before and after the label is attached is the same number. */
  it("keeps the confirmed coordinate bit-identical", () => {
    const labelled = withReverseLabel(clicked, {
      at: { latitude: 3.139013, longitude: 101.686855 },
      label: "Jalan Tun Razak, Kuala Lumpur",
      ref: "way/9",
    })!;
    expect(Object.is(labelled.latitude, clicked.latitude)).toBe(true);
    expect(Object.is(labelled.longitude, clicked.longitude)).toBe(true);
    expect(labelled.resolved).toEqual({ by: "reverse", label: "Jalan Tun Razak, Kuala Lumpur", ref: "way/9" });
  });

  /** Two quick clicks, two lookups: the first answer must not label the second point. */
  it("ignores an answer about a point that is no longer pending", () => {
    const stale = withReverseLabel(clicked, { at: { latitude: 3.1, longitude: 101.6 }, label: "elsewhere", ref: "way/1" });
    expect(stale).toBe(clicked);
  });

  it("does not overwrite a search pick's label with a reverse one", () => {
    const picked: PickedPoint = { ...clicked, resolved: { by: "search", label: "Chosen", ref: "way/2", query: "chosen" } };
    expect(withReverseLabel(picked, { at: clicked, label: "other", ref: "way/3" })).toBe(picked);
  });
});

describe("what the create request carries for an address", () => {
  /**
   * THE LABEL IS NOT SENT. The server is told which lookup produced it and
   * reads the label back from its own cache — a client cannot type one in.
   */
  it("sends a reference to the lookup, never the label text", () => {
    const body = bodyPoint({ ...inside, claim: "Gate B", resolved: { by: "search", label: "Jalan X", ref: "way/7", query: "jalan x" } });
    expect(body).toEqual({
      latitude: inside.latitude,
      longitude: inside.longitude,
      addressClaim: "Gate B",
      resolution: { kind: "search", query: "jalan x", ref: "way/7" },
    });
    expect(JSON.stringify(body)).not.toContain("Jalan X");
    expect(bodyPoint({ ...inside, resolved: { by: "reverse", label: "Jalan Y", ref: "way/8" } }).resolution).toEqual({ kind: "reverse" });
    expect(bodyPoint(inside)).not.toHaveProperty("resolution");
  });
});

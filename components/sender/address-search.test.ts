// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AddressSearch } from "./address-search";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const INSIDE = {
  ref: "way/1",
  label: "Jalan Ampang, Kuala Lumpur",
  latitude: 3.157912,
  longitude: 101.711612,
  selectable: true,
};
const OUTSIDE = {
  ref: "node/2",
  label: "Jalan Ampang, Ipoh, Perak",
  latitude: 4.5975,
  longitude: 101.0901,
  selectable: false,
  refusal: "This point is outside the service area. Covered: Kuala Lumpur, Petaling, Hulu Langat, Sepang.",
};

function answering(body: unknown) {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("address search sends nothing while you type", () => {
  /**
   * NOMINATIM FORBIDS AUTOCOMPLETE, and this is the pin. Twenty keystrokes'
   * worth of changes, every prefix of an address that would have matched
   * something, and the request count stays at zero. Only the button sends.
   */
  it("makes no request on any change, and exactly one on Search", async () => {
    const fetcher = answering({ status: "found", query: "jalan ampang", candidates: [INSIDE], attribution: "credit" });
    const onChoose = vi.fn();
    const view = render(createElement(AddressSearch, { onChoose }));
    const box = view.getByLabelText("Search for an address");
    const typed = "Jalan Ampang, Kuala Lumpur";
    for (let n = 1; n <= typed.length; n += 1) fireEvent.change(box, { target: { value: typed.slice(0, n) } });
    fireEvent.keyDown(box, { key: "a" });
    fireEvent.input(box, { target: { value: typed } });
    expect(fetcher).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/sender/geocode/search");
    // THE DATA BOUNDARY: one field, the typed text.
    expect(JSON.parse(init.body)).toEqual({ query: typed });
  });

  it("refuses a phone number before any request exists", async () => {
    const fetcher = answering({});
    const view = render(createElement(AddressSearch, { onChoose: vi.fn() }));
    fireEvent.change(view.getByLabelText("Search for an address"), { target: { value: "+60 11-999 0007" } });
    fireEvent.click(view.getByRole("button", { name: "Search" }));
    expect(view.getByRole("alert").textContent).toMatch(/looks like a phone number/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("a result is proposed, never adopted", () => {
  it("does not choose anything by itself, even when there is exactly one match", async () => {
    answering({ status: "found", query: "jalan ampang", candidates: [INSIDE], attribution: "credit" });
    const onChoose = vi.fn();
    const view = render(createElement(AddressSearch, { onChoose }));
    fireEvent.change(view.getByLabelText("Search for an address"), { target: { value: "jalan ampang" } });
    fireEvent.click(view.getByRole("button", { name: "Search" }));
    await view.findByText(INSIDE.label);
    expect(onChoose).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Use this place" }));
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(INSIDE, "jalan ampang");
  });

  /**
   * An outside candidate is answered with the reason and the four covered
   * units, and has NO "use" control — absent, not disabled.
   */
  it("shows an outside candidate with its reason and no way to use it", async () => {
    answering({ status: "found", query: "jalan ampang", candidates: [OUTSIDE, INSIDE], attribution: "credit" });
    const view = render(createElement(AddressSearch, { onChoose: vi.fn() }));
    fireEvent.change(view.getByLabelText("Search for an address"), { target: { value: "jalan ampang" } });
    fireEvent.click(view.getByRole("button", { name: "Search" }));
    const outsideRow = (await view.findByText(OUTSIDE.label)).closest("li")!;
    for (const member of ["Kuala Lumpur", "Petaling", "Hulu Langat", "Sepang"]) {
      expect(outsideRow.textContent).toContain(member);
    }
    expect(outsideRow.querySelector("button")).toBeNull();
    expect(view.getAllByRole("button", { name: "Use this place" })).toHaveLength(1);
  });

  it("shows the server's reason for a failure and no candidates at all", async () => {
    answering({ status: "failed", reason: "timeout", message: "The geocoder did not answer in time.", attribution: "credit" });
    const view = render(createElement(AddressSearch, { onChoose: vi.fn() }));
    fireEvent.change(view.getByLabelText("Search for an address"), { target: { value: "jalan ampang" } });
    fireEvent.click(view.getByRole("button", { name: "Search" }));
    const alert = await view.findByRole("alert");
    expect(alert.getAttribute("data-reason")).toBe("timeout");
    expect(alert.textContent).toBe("The geocoder did not answer in time.");
    expect(view.queryByRole("list", { name: "Search results" })).toBeNull();
  });
});

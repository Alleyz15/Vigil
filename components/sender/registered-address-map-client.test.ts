// @vitest-environment jsdom
import { createElement, StrictMode, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { RegisteredAddressMapClient } from "./registered-address-map-client";

const map = vi.hoisted(() => ({ fitBounds: vi.fn() }));
vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  TileLayer: ({ url, attribution, eventHandlers }: { url: string; attribution: string; eventHandlers: { tileerror: () => void } }) =>
    createElement("button", { "data-url": url, "data-attribution": attribution, onClick: eventHandlers.tileerror }, "Tile error fixture"),
  Marker: ({ title, position, children, eventHandlers }: { title: string; position: number[]; children: ReactNode; eventHandlers: { click: () => void; keydown?: (event: { originalEvent: KeyboardEvent }) => void } }) =>
    createElement("div", null, createElement("button", { "data-position": JSON.stringify(position), onClick: eventHandlers.click,
      onKeyDown: (event) => eventHandlers.keydown?.({ originalEvent: event.nativeEvent }) }, title), children),
  Tooltip: ({ children, permanent }: { children: ReactNode; permanent: boolean }) => createElement("span", { "data-permanent": permanent }, children),
  useMap: () => map,
  Polyline: () => { throw new Error("Registered places must not draw a route"); },
  useMapEvents: () => { throw new Error("Free map clicks must not create registered points"); },
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const addresses = [
  { index: 4, label: "Origin", latitude: 3.16, longitude: 101.73 },
  { index: 20, label: "Destination", latitude: 3.09, longitude: 101.54 },
  { index: 31, label: "Other", latitude: 3.07, longitude: 101.58 },
];

it("frames every cached location once on mount, including React Strict Mode", () => {
  render(createElement(StrictMode, null, createElement(RegisteredAddressMapClient, { addresses, originIndex: 4, destinationIndex: 20, onSelect: vi.fn() })));
  expect(map.fitBounds).toHaveBeenCalledTimes(1);
  expect(map.fitBounds.mock.calls[0][0]).toEqual(addresses.map(a => [a.latitude, a.longitude]));
});

it("selects original indices at exact coordinates and updates the selected endpoint labels", () => {
  const onSelect = vi.fn();
  const view = render(createElement(RegisteredAddressMapClient, { addresses, originIndex: 4, destinationIndex: 20, onSelect }));
  expect(view.getByRole("button", { name: "Choose Other" }).dataset.position).toBe("[3.07,101.58]");
  fireEvent.click(view.getByRole("button", { name: "Choose Other" }));
  expect(onSelect).toHaveBeenCalledWith(31);
  view.rerender(createElement(RegisteredAddressMapClient, { addresses, originIndex: 4, destinationIndex: 31, onSelect }));
  expect(view.getByText("Delivery · Other").dataset.permanent).toBe("true");
  expect(view.getByText("Pickup · Origin").dataset.permanent).toBe("true");
  expect(map.fitBounds.mock.calls.at(-1)?.[0]).toEqual([[3.16, 101.73], [3.07, 101.58]]);
});

it("uses attributed OSM tiles and preserves selection when a tile fails", () => {
  const onSelect = vi.fn();
  const view = render(createElement(RegisteredAddressMapClient, { addresses, originIndex: 4, destinationIndex: 20, onSelect }));
  const tile = view.getByRole("button", { name: "Tile error fixture" });
  expect(tile.dataset.url).toBe("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png");
  expect(tile.dataset.attribution).toContain("https://www.openstreetmap.org/copyright");
  fireEvent.click(tile);
  expect(view.getByRole("status").textContent).toContain("Some map tiles could not load");
  fireEvent.click(view.getByRole("button", { name: "Choose Other" }));
  expect(onSelect).toHaveBeenCalledWith(31);
});

it("activates focused registered markers with Enter or Space", () => {
  const onSelect = vi.fn();
  const view = render(createElement(RegisteredAddressMapClient, { addresses, originIndex: 4, destinationIndex: 20, onSelect }));
  const marker = view.getByRole("button", { name: "Choose Other" });
  fireEvent.keyDown(marker, { key: "Enter" });
  fireEvent.keyDown(marker, { key: " " });
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(onSelect).toHaveBeenLastCalledWith(31);
});

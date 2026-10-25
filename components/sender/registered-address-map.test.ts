// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { RegisteredAddressMap } from "./registered-address-map";
import type { SenderAddress } from "./sender-form";

const captured = vi.hoisted(() => ({ props: null as null | {
  addresses: SenderAddress[]; originIndex: number; destinationIndex: number; onSelect: (index: number) => void;
} }));
vi.mock("next/dynamic", () => ({ default: () => (props: NonNullable<typeof captured.props>) => {
  captured.props = props;
  return createElement("div", { "aria-label": "Registered OpenStreetMap" },
    ...props.addresses.map(a => createElement("button", { key: a.index, onClick: () => props.onSelect(a.index) }, `Map: ${a.label}`)));
} }));
afterEach(() => { cleanup(); captured.props = null; });
const addresses: SenderAddress[] = [
  { index: 4, label: "Origin", latitude: 3.16, longitude: 101.73 },
  { index: 20, label: "Destination", latitude: 3.09, longitude: 101.54 },
  { index: 31, label: "Registered without coordinate" },
];

it("passes exact registered coordinates and original indices to the browser map", () => {
  const view = render(createElement(RegisteredAddressMap, { addresses, serviceArea: "Fixture area", originIndex: 4,
    destinationIndex: 20, onOriginChange: vi.fn(), onDestinationChange: vi.fn() }));
  expect(view.getByLabelText("Registered OpenStreetMap")).toBeTruthy();
  expect(captured.props?.addresses).toEqual(addresses.slice(0, 2));
  expect(captured.props?.originIndex).toBe(4);
  expect(captured.props?.destinationIndex).toBe(20);
  expect(view.queryByText(/Straight-line approximation/)).toBeNull();
});

it("routes marker and search selections to the chosen declaration field", () => {
  const onOriginChange = vi.fn(), onDestinationChange = vi.fn();
  const view = render(createElement(RegisteredAddressMap, { addresses, serviceArea: "Fixture area", originIndex: 4,
    destinationIndex: 20, onOriginChange, onDestinationChange }));
  fireEvent.click(view.getByRole("button", { name: "Map: Origin" }));
  expect(onDestinationChange).toHaveBeenLastCalledWith(4);
  fireEvent.click(view.getByRole("button", { name: "Pickup point" }));
  fireEvent.click(view.getByRole("button", { name: "Map: Destination" }));
  expect(onOriginChange).toHaveBeenLastCalledWith(20);
  fireEvent.change(view.getByLabelText("Search registered addresses"), { target: { value: "without coordinate" } });
  fireEvent.click(view.getByRole("button", { name: "Registered without coordinate" }));
  expect(onOriginChange).toHaveBeenLastCalledWith(31);
});

it("keeps form and search selection available when coordinates are missing", () => {
  const view = render(createElement(RegisteredAddressMap, { addresses: [addresses[2]], serviceArea: "Fixture area",
    originIndex: 31, destinationIndex: 31, onOriginChange: vi.fn(), onDestinationChange: vi.fn() }));
  expect(view.getByText(/Registered coordinates unavailable/)).toBeTruthy();
  expect(view.queryByLabelText("Registered OpenStreetMap")).toBeNull();
});

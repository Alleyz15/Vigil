// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ShipmentMapModel } from "@/lib/workbench/map-model";
import { ShipmentMapClient } from "./shipment-map-client";

const map = vi.hoisted(() => ({ fitBounds: vi.fn(), setView: vi.fn() }));
vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  TileLayer: () => null,
  Tooltip: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Circle: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  CircleMarker: ({ children, center }: { children: ReactNode; center: number[] }) =>
    createElement("div", { "data-testid": "map-marker", "data-center": JSON.stringify(center) }, children),
  Polyline: ({ children, eventHandlers, pathOptions }: {
    children: ReactNode; eventHandlers: { click: () => void }; pathOptions: { className?: string };
  }) => createElement("button", { onClick: eventHandlers.click, className: pathOptions.className }, children),
  useMap: () => map,
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function model(): ShipmentMapModel {
  const reference = { latitude: 3.165, longitude: 101.73 };
  const scan = { latitude: 3.13, longitude: 101.62 };
  return {
    route: [],
    locations: [{ id: "delivery", kind: "delivery", label: "Recorded recipient reference",
      mapLabel: "Recorded reference", detail: "Original record", point: reference, monitored: true }],
    overlays: [{ id: "delivery-reported-scan", kind: "marker", label: "Reported delivery scan",
      detail: "Submitted GPS", point: scan, evidenceId: "I10", eventId: "submitted-event",
      group: "delivery-reference", provenance: "submitted EPCIS GPS signal", precision: "reported" },
    { id: "delivery-reference-I10", kind: "line", label: "GPS and recorded recipient reference disagree",
      detail: "Evidence connector, not a travelled route", point: scan, points: [scan, reference],
      evidenceId: "I10", eventId: "submitted-event", group: "delivery-reference",
      provenance: "submitted EPCIS GPS signal and recorded recipient reference", precision: "derived" }],
    notices: [],
  };
}

it("shows and frames both the reference and reported scan before evidence overlays are revealed", () => {
  const view = render(createElement(ShipmentMapClient, { model: model(), activeLegIndex: 5,
    revealOverlays: false, selectedEvidenceId: null, onSelectEvidence: vi.fn() }));

  expect(view.getAllByTestId("map-marker").map((marker) => JSON.parse(marker.dataset.center!)))
    .toEqual([[3.165, 101.73], [3.13, 101.62]]);
  expect(view.queryByRole("button")).toBeNull();
  expect(map.fitBounds).toHaveBeenLastCalledWith([[3.165, 101.73], [3.13, 101.62]], expect.anything());
});

it("labels and selects the actual spatial evidence rather than claiming every line is a cell conflict", () => {
  const onSelectEvidence = vi.fn();
  const view = render(createElement(ShipmentMapClient, { model: model(), activeLegIndex: 5,
    revealOverlays: true, selectedEvidenceId: "I10", onSelectEvidence }));

  const line = view.getByRole("button", { name: "GPS and recorded recipient reference disagree" });
  expect(line.className).toBe("map-evidence-selected");
  fireEvent.click(line);
  expect(onSelectEvidence).toHaveBeenCalledWith("I10");
  expect(view.queryByText("GPS ↔ cell contradiction")).toBeNull();
});

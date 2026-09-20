"use client";

import { useEffect } from "react";
import { bbox } from "@turf/turf";
import { CircleMarker, GeoJSON, MapContainer, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { formatCoordinate } from "@/lib/shipment/picker";
import type { PickedPoint, ServiceAreaView } from "./online-shipment-model";

/**
 * THE SHAPE IS DRAWN BEFORE ANYONE CLICKS.
 *
 * A service area a person discovers by being refused is a disabled button with
 * extra steps. The outline is on the map from the first frame, the four members
 * are named under it, and the boundary's own credit and extraction date sit in
 * the corner — the licence condition travels with the geometry, so this surface
 * prints what the boundary carries rather than keeping its own copy.
 *
 * THE MAP SNAPS TO NOTHING. A click is a coordinate: it is not moved to a road,
 * a building, an address or a cached point, and no geocoder is asked what is
 * there. The marker sits exactly where the confirmed number says.
 */

const INSIDE = "#15803d";
const OUTSIDE = "#c24138";
const ORIGIN = "#0f766e";
const DESTINATION = "#b45309";

function Frame({ area }: { area: ServiceAreaView["area"] }) {
  const map = useMap();
  useEffect(() => {
    const [west, south, east, north] = bbox(area);
    map.fitBounds(
      [
        [south, west],
        [north, east],
      ],
      { padding: [18, 18] },
    );
  }, [area, map]);
  return null;
}

function ClickToPick({ onPick }: { onPick: (latitude: number, longitude: number) => void }) {
  useMapEvents({
    click: (event) => onPick(event.latlng.lat, event.latlng.lng),
  });
  return null;
}

function Marker({
  point,
  color,
  label,
  radius,
}: {
  point: PickedPoint;
  color: string;
  label: string;
  radius: number;
}) {
  return (
    <CircleMarker
      center={[point.latitude, point.longitude]}
      radius={radius}
      pathOptions={{ color: "#ffffff", weight: 2, fillColor: color, fillOpacity: 1 }}
    >
      <Tooltip direction="top" offset={[0, -6]}>
        <strong>{label}</strong>
        <br />
        {formatCoordinate(point.latitude)}, {formatCoordinate(point.longitude)}
      </Tooltip>
    </CircleMarker>
  );
}

export function ServiceAreaMapClient({
  area,
  pending,
  origin,
  destination,
  onPick,
}: {
  area: ServiceAreaView;
  pending: PickedPoint | null;
  origin: PickedPoint | null;
  destination: PickedPoint | null;
  onPick: (latitude: number, longitude: number) => void;
}) {
  return (
    <div className="relative h-[430px] overflow-hidden rounded-md bg-muted">
      <MapContainer center={[3.139, 101.6869]} zoom={10} scrollWheelZoom className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Frame area={area.area} />
        <ClickToPick onPick={onPick} />
        <GeoJSON
          // Keyed on the version so a boundary change redraws rather than
          // leaving the previous outline on screen.
          key={area.version}
          data={area.area}
          style={{
            color: area.placeholder ? "#64748b" : INSIDE,
            weight: 2,
            dashArray: area.placeholder ? "6 5" : undefined,
            fillColor: area.placeholder ? "#64748b" : INSIDE,
            fillOpacity: 0.07,
          }}
          interactive={false}
        />
        {origin && <Marker point={origin} color={ORIGIN} label="Collection point" radius={7} />}
        {destination && <Marker point={destination} color={DESTINATION} label="Delivery point" radius={7} />}
        {pending && (
          <Marker
            point={pending}
            color={pending.inside ? INSIDE : OUTSIDE}
            label={pending.inside ? "Point to confirm" : "Outside the service area"}
            radius={9}
          />
        )}
      </MapContainer>

      {/*
        On the map, not only in the API response and the operator's view. ODbL
        requires the credit wherever the data is used, and the extraction date
        is what makes "which boundary was this checked against" answerable by
        the person doing the checking.
      */}
      <div className="pointer-events-none absolute bottom-6 left-3 z-[500] max-w-[26rem] rounded-md border bg-white/95 px-3 py-2 shadow-sm">
        <p className="text-xs font-semibold text-slate-900">{area.sentence}</p>
        <p className="mt-1 text-xs leading-5 text-slate-600">{area.credit}</p>
        {area.showExtracted && (
          <p className="mt-0.5 text-xs leading-5 text-slate-600">Extracted {area.extracted}</p>
        )}
      </div>
    </div>
  );
}

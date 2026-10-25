"use client";

import { useEffect, useRef, useState } from "react";
import { divIcon } from "leaflet";
import { MapContainer, Marker, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { SenderAddress } from "./sender-form";

export type RegisteredMapAddress = SenderAddress & { latitude: number; longitude: number };
export type RegisteredAddressMapClientProps = {
  addresses: RegisteredMapAddress[];
  originIndex: number;
  destinationIndex: number;
  onSelect: (index: number) => void;
};

function pointIcon(color: string, selected = false) {
  // Static HTML only: address labels are React text in the tooltip, never HTML.
  return divIcon({ className: "registered-map-point", iconSize: [32, 32], iconAnchor: [16, 16],
    html: `<span style="display:flex;width:32px;height:32px;align-items:center;justify-content:center"><span style="display:block;width:${selected ? 16 : 10}px;height:${selected ? 16 : 10}px;border:2px solid white;border-radius:50%;background:${color}"></span></span>` });
}
const ICONS = {
  ordinary: pointIcon("#64748b"), pickup: pointIcon("#047857", true),
  delivery: pointIcon("#b45309", true), both: pointIcon("#7c3aed", true),
};

function Viewport({ addresses, originIndex, destinationIndex }: Omit<RegisteredAddressMapClientProps, "onSelect">) {
  const map = useMap();
  const previous = useRef<{ addresses: RegisteredMapAddress[]; originIndex: number; destinationIndex: number } | null>(null);
  useEffect(() => {
    const initial = !previous.current || previous.current.addresses !== addresses;
    if (!initial && previous.current?.originIndex === originIndex && previous.current.destinationIndex === destinationIndex) return;
    const selected = addresses.filter(a => a.index === originIndex || a.index === destinationIndex);
    const visible = initial || selected.length === 0 ? addresses : selected;
    if (visible.length) map.fitBounds(visible.map(a => [a.latitude, a.longitude] as [number, number]),
      { padding: [60, 48], maxZoom: 13, animate: false });
    previous.current = { addresses, originIndex, destinationIndex };
  }, [addresses, originIndex, destinationIndex, map]);
  return null;
}

/** The registered-address picker never accepts a free coordinate or draws a route. */
export function RegisteredAddressMapClient({ addresses, originIndex, destinationIndex, onSelect }: RegisteredAddressMapClientProps) {
  const [tileError, setTileError] = useState(false);
  return (
    <div role="region" aria-label="Registered OpenStreetMap" className="relative isolate aspect-[8/5] min-h-[320px] w-full min-w-0 bg-muted">
      <MapContainer center={[3.139, 101.6869]} zoom={10} scrollWheelZoom={false} className="h-full w-full">
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          eventHandlers={{ tileerror: () => setTileError(true) }} />
        <Viewport addresses={addresses} originIndex={originIndex} destinationIndex={destinationIndex} />
        {addresses.map(address => {
          const pickup = address.index === originIndex, delivery = address.index === destinationIndex;
          const kind = pickup && delivery ? "both" : pickup ? "pickup" : delivery ? "delivery" : "ordinary";
          const role = pickup && delivery ? "Pickup + Delivery" : pickup ? "Pickup" : delivery ? "Delivery" : null;
          return (
            <Marker key={address.index} position={[address.latitude, address.longitude]} icon={ICONS[kind]}
              title={`Choose ${address.label}`} keyboard autoPanOnFocus zIndexOffset={role ? 1000 : 0}
              eventHandlers={{
                click: () => onSelect(address.index),
                keydown: ({ originalEvent }) => {
                  if (originalEvent.key === "Enter" || originalEvent.key === " ") {
                    originalEvent.preventDefault();
                    onSelect(address.index);
                  }
                },
              }}>
              <Tooltip key={kind} permanent={Boolean(role)} direction={pickup ? "bottom" : "top"} offset={[0, pickup ? 10 : -10]}>
                {role ? `${role} · ` : ""}{address.label}
              </Tooltip>
            </Marker>
          );
        })}
      </MapContainer>
      {tileError && <p role="status" className="absolute inset-x-3 bottom-7 z-[500] rounded border bg-card px-3 py-2 text-xs text-card-foreground">
        Some map tiles could not load. Registered markers, address search and form selections remain available.
      </p>}
    </div>
  );
}

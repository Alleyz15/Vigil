"use client";
import { useState } from "react";
import { MapPin, Search } from "lucide-react";
import type { SenderAddress } from "./sender-form";
import { cn } from "@/lib/utils";
import { ProvenanceLabel } from "@/components/operator/provenance-label";

export function RegisteredAddressMap({ addresses, serviceArea, originIndex, destinationIndex, onOriginChange, onDestinationChange }: {
  addresses: SenderAddress[];
  /**
   * The service area, named by LISTING its members — read from the boundary on
   * the server, not written here. This line used to say "Klang Valley", which
   * officially includes Klang and Gombak, where this project has no address and
   * no depot: a label claiming coverage nobody measured.
   */
  serviceArea: string;
  originIndex: number; destinationIndex: number;
  onOriginChange: (index: number) => void; onDestinationChange: (index: number) => void;
}) {
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<"pickup" | "delivery">("delivery");
  const points = addresses.flatMap((a) => Number.isFinite(a.latitude) && Number.isFinite(a.longitude) ? [{ ...a, latitude: a.latitude!, longitude: a.longitude! }] : []);
  const minLat = Math.min(...points.map((a) => a.latitude));
  const maxLat = Math.max(...points.map((a) => a.latitude));
  const minLng = Math.min(...points.map((a) => a.longitude));
  const maxLng = Math.max(...points.map((a) => a.longitude));
  const project = (a: typeof points[number]) => ({ x: 8 + (a.longitude - minLng) / (maxLng - minLng || 1) * 84, y: 8 + (maxLat - a.latitude) / (maxLat - minLat || 1) * 84 });
  const origin = points.find((a) => a.index === originIndex);
  const destination = points.find((a) => a.index === destinationIndex);
  const from = origin && project(origin), to = destination && project(destination);
  const matches = addresses.filter((a) => a.label.toLowerCase().includes(search.trim().toLowerCase()));
  const choose = (index: number) => target === "pickup" ? onOriginChange(index) : onDestinationChange(index);
  return (
    <section aria-label="Registered delivery points" className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="space-y-3 p-5">
        <h2 className="text-sm font-semibold">Choose a registered delivery point</h2>
        <p className="text-xs text-muted-foreground">{serviceArea}</p>
        <p className="text-xs text-muted-foreground">{addresses.length} registered locations on file</p>
        <ProvenanceLabel>Cached geocoded addresses · synthetic reference signals</ProvenanceLabel>
        <p className="text-xs leading-5 text-muted-foreground">Address coordinates are cached from real geocoded locations. Cell and WiFi references are derived simulated data, not live observations. Generation uses the fixed cache without network queries.</p>
        <label className="flex items-center gap-2 rounded-md border px-3"><Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><input aria-label="Search registered addresses" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search registered addresses" className="h-9 min-w-0 flex-1 text-sm outline-none" /></label>
        <div role="group" aria-label="Point selection target" className="flex gap-2">
          {(["pickup", "delivery"] as const).map((mode) => <button key={mode} type="button" aria-pressed={target === mode} onClick={() => setTarget(mode)} className={cn("rounded px-3 py-1.5 text-xs", target === mode ? "bg-primary text-primary-foreground" : "bg-muted")}>{mode === "pickup" ? "Pickup point" : "Delivery point"}</button>)}
        </div>
      </div>
      <div className="relative aspect-[8/5] bg-emerald-50" aria-label="Registered coordinate overview">
        {from && to && <div aria-hidden="true" className="pointer-events-none absolute origin-left border-t-2 border-dashed border-gray-400" style={{ left: `${from.x}%`, top: `${from.y}%`, width: `${Math.hypot(to.x - from.x, (to.y - from.y) / 1.6)}%`, transform: `rotate(${Math.atan2((to.y - from.y) / 1.6, to.x - from.x) * 180 / Math.PI}deg)` }} />}
        {points.map((a) => {
          const pos = project(a); const active = a.index === originIndex || a.index === destinationIndex;
          return <button key={a.index} type="button" aria-label={`Choose ${a.label}`} title={a.label} onClick={() => choose(a.index)} className={cn("absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-primary", active && "z-10")} style={{ left: `${pos.x}%`, top: `${pos.y}%` }}><span className={cn("size-2 rounded-full border border-white bg-emerald-700", active && "size-3 ring-2 ring-white", a.index === destinationIndex && "bg-amber-600")} /></button>;
        })}
        {points.length === 0 && <p className="p-5 text-sm text-muted-foreground">Registered coordinates unavailable. Select an address from the form.</p>}
      </div>
      <div className="space-y-3 p-5">
        <p className="flex gap-2 text-xs"><MapPin aria-hidden="true" className="size-4 shrink-0 text-emerald-700" />Pickup: {addresses.find((a) => a.index === originIndex)?.label ?? "Not selected"}</p>
        <p className="flex gap-2 text-xs"><MapPin aria-hidden="true" className="size-4 shrink-0 text-amber-600" />Delivery: {addresses.find((a) => a.index === destinationIndex)?.label ?? "Not selected"}</p>
        <p className="text-xs leading-5 text-muted-foreground">Straight-line approximation · not navigation or live tracking. Registered points only; no new-address geocoding.</p>
        {search.trim() && <ul aria-label="Registered address search results" className="max-h-40 overflow-y-auto border-t pt-2">
          {matches.map((a) => <li key={a.index}><button type="button" onClick={() => choose(a.index)} className="w-full py-2 text-left text-xs hover:text-primary">{a.label}</button></li>)}
          {matches.length === 0 && <li className="py-2 text-xs text-muted-foreground">No registered address matches.</li>}
        </ul>}
      </div>
    </section>
  );
}

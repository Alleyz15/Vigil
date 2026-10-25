"use client";
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { MapPin, Search } from "lucide-react";
import type { SenderAddress } from "./sender-form";
import { cn } from "@/lib/utils";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import type { RegisteredMapAddress } from "./registered-address-map-client";

const ClientMap = dynamic(() => import("./registered-address-map-client").then(m => m.RegisteredAddressMapClient), {
  ssr: false,
  loading: () => <div role="status" className="flex aspect-[8/5] min-h-[320px] w-full min-w-0 items-center justify-center bg-muted text-sm text-muted-foreground">Loading registered-location map…</div>,
});

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
  const points = useMemo(() => addresses.filter((address): address is RegisteredMapAddress =>
    Number.isFinite(address.latitude) && Number.isFinite(address.longitude)), [addresses]);
  const matches = addresses.filter((a) => a.label.toLowerCase().includes(search.trim().toLowerCase()));
  const choose = (index: number) => target === "pickup" ? onOriginChange(index) : onDestinationChange(index);
  return (
    <section aria-label="Registered delivery points" className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="space-y-3 p-5">
        <h2 className="text-sm font-semibold">Choose a registered delivery point</h2>
        <p className="text-xs text-muted-foreground">{serviceArea}</p>
        <p className="text-xs text-muted-foreground">{addresses.length} registered locations on file</p>
        <ProvenanceLabel>Cached geocoded addresses · synthetic reference signals</ProvenanceLabel>
        <p className="text-xs leading-5 text-muted-foreground">Address coordinates are cached from real geocoded locations. Cell and WiFi references are simulated, not live observations. OpenStreetMap supplies the background tiles; selecting a registered point does not geocode or move it.</p>
        <label className="flex items-center gap-2 rounded-md border px-3"><Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><input aria-label="Search registered addresses" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search registered addresses" className="h-9 min-w-0 flex-1 text-sm outline-none" /></label>
        <div role="group" aria-label="Point selection target" className="flex gap-2">
          {(["pickup", "delivery"] as const).map((mode) => <button key={mode} type="button" aria-pressed={target === mode} onClick={() => setTarget(mode)} className={cn("rounded px-3 py-1.5 text-xs", target === mode ? "bg-primary text-primary-foreground" : "bg-muted")}>{mode === "pickup" ? "Pickup point" : "Delivery point"}</button>)}
        </div>
      </div>
      {points.length > 0
        ? <ClientMap addresses={points} originIndex={originIndex} destinationIndex={destinationIndex} onSelect={choose} />
        : <p className="bg-muted p-5 text-sm text-muted-foreground">Registered coordinates unavailable. Select an address from the form.</p>}
      <div className="space-y-3 p-5">
        <p className="flex gap-2 text-xs"><MapPin aria-hidden="true" className="size-4 shrink-0 text-emerald-700" />Pickup: {addresses.find((a) => a.index === originIndex)?.label ?? "Not selected"}</p>
        <p className="flex gap-2 text-xs"><MapPin aria-hidden="true" className="size-4 shrink-0 text-amber-600" />Delivery: {addresses.find((a) => a.index === destinationIndex)?.label ?? "Not selected"}</p>
        <p className="text-xs leading-5 text-muted-foreground">Registered location markers only · not navigation or live tracking. Choose a marker or search the registered addresses; arbitrary map clicks do not create new locations.</p>
        {search.trim() && <ul aria-label="Registered address search results" className="max-h-40 overflow-y-auto border-t pt-2">
          {matches.map((a) => <li key={a.index}><button type="button" onClick={() => choose(a.index)} className="w-full py-2 text-left text-xs hover:text-primary">{a.label}</button></li>)}
          {matches.length === 0 && <li className="py-2 text-xs text-muted-foreground">No registered address matches.</li>}
        </ul>}
      </div>
    </section>
  );
}

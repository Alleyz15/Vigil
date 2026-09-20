"use client";

import dynamic from "next/dynamic";
import type { ServiceAreaView, PickedPoint } from "./online-shipment-model";

/**
 * Leaflet only runs in a browser, so the map is loaded client-side. The panel
 * around it renders either way; a viewer never sees the page without the
 * service-area sentence and the attribution, only without the tiles.
 */
const ClientMap = dynamic(() => import("./service-area-map-client").then((m) => m.ServiceAreaMapClient), {
  ssr: false,
  loading: () => (
    <div className="flex h-[430px] items-center justify-center bg-muted text-sm text-muted-foreground">
      Loading the service-area map…
    </div>
  ),
});

export function ServiceAreaMap(props: {
  area: ServiceAreaView;
  pending: PickedPoint | null;
  origin: PickedPoint | null;
  destination: PickedPoint | null;
  onPick: (latitude: number, longitude: number) => void;
}) {
  return <ClientMap {...props} />;
}

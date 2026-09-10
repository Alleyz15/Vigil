"use client";

import dynamic from "next/dynamic";
import type { ShipmentMapModel } from "@/lib/workbench";

const ClientMap = dynamic(
  () => import("./shipment-map-client").then((module) => module.ShipmentMapClient),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[430px] items-center justify-center bg-muted text-sm text-muted-foreground">
        Loading route map…
      </div>
    ),
  },
);

export function ShipmentMap(props: {
  model: ShipmentMapModel;
  activeLegIndex: number;
  revealOverlays: boolean;
  selectedEvidenceId: string | null;
  onSelectEvidence: (id: string | null) => void;
}) {
  return <ClientMap {...props} />;
}

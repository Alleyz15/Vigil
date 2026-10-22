import { ArrowRight, MapPin } from "lucide-react";
import type { RouteLocationView, ShipmentRouteView } from "@/lib/workbench";
import { cn } from "@/lib/utils";

const SOURCE_LABEL: Record<RouteLocationView["source"], string> = {
  registered: "Registered location",
  sender_claim: "Sender address note",
  geocoder_search: "Geocoder label · chosen search result",
  geocoder_reverse: "Geocoder label · reverse lookup",
  coordinate: "Confirmed coordinate · no address label",
};

export function RouteSummary({ route, className }: { route: ShipmentRouteView; className?: string }) {
  return (
    <div className={cn("grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center", className)}>
      {route.origin ? <Location title="Collection point" location={route.origin} /> : <Unavailable title="Collection point" />}
      <ArrowRight aria-hidden="true" className="hidden size-4 text-muted-foreground sm:block" />
      <Location title="Delivery point" location={route.destination} />
    </div>
  );
}

export function OperatorJourneySummary({ route, className }: { route: ShipmentRouteView; className?: string }) {
  if (!route.custody) return <RouteSummary route={route} className={className} />;
  return (
    <div className={cn("grid min-w-0 gap-4 lg:grid-cols-3", className)}>
      <JourneyStage
        title="Sender reference"
        value={route.origin?.label ?? "Not provided"}
        detail="Context only · no carrier pickup scan"
      />
      <JourneyStage
        title="Carrier custody"
        value={`${route.custody.originDepot.label} → ${route.custody.destinationDepot.label}`}
        detail="Verified carrier handling begins at the origin depot"
      />
      <JourneyStage
        title="Current last-mile handoff"
        value={`${route.custody.destinationDepot.label} → ${route.destination.label}`}
        detail="Destination depot to delivery reference"
      />
    </div>
  );
}

function JourneyStage({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 border-l-2 border-primary/30 pl-3">
      <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <MapPin aria-hidden="true" className="size-3.5 shrink-0" />
        {title}
      </p>
      <p className="mt-1 text-sm font-semibold leading-5">{value}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

function Location({ title, location }: { title: string; location: RouteLocationView }) {
  const showClaim = location.senderClaim && location.source.startsWith("geocoder_");
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <MapPin aria-hidden="true" className="size-3.5 shrink-0" />
        {title}
      </p>
      <p className="mt-1 text-sm font-medium leading-5">{location.label}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{SOURCE_LABEL[location.source]}</p>
      {location.coordinate && location.source !== "coordinate" && (
        <p className="font-mono text-xs leading-5 text-muted-foreground">{location.coordinate}</p>
      )}
      {showClaim && (
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Sender note: <span className="text-foreground">{location.senderClaim}</span>
        </p>
      )}
    </div>
  );
}

function Unavailable({ title }: { title: string }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <MapPin aria-hidden="true" className="size-3.5 shrink-0" />
        {title}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">Not included in this prepared view</p>
    </div>
  );
}

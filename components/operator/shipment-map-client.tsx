"use client";

import { useEffect } from "react";
import {
  Circle,
  CircleMarker,
  MapContainer,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import type { MapLocation, MapOverlay, MapPoint, ShipmentMapModel } from "@/lib/workbench";

/** Operational places are markers. Lines are reserved for evidence conflicts. */
const ROUTE_COLOR = "#64748b";
const ALERT_COLOR = "#c24138";
const CONTEXT_COLOR = "#16778a";

function latLng(point: MapPoint): [number, number] {
  return [point.latitude, point.longitude];
}

function Viewport({
  model,
  revealOverlays,
}: {
  model: ShipmentMapModel;
  revealOverlays: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    const points = model.locations.map((location) => latLng(location.point));
    // A submitted scan is context even before the operator reveals risk evidence.
    const scans = model.overlays.filter((feature) => feature.id === "delivery-reported-scan");
    for (const scan of scans) if (scan.point) points.push(latLng(scan.point));
    const evidencePoints = revealOverlays
      ? model.overlays.flatMap((feature) =>
          feature.points?.length
            ? feature.points.map(latLng)
            : feature.point
              ? [latLng(feature.point)]
              : [],
        )
      : [];
    const focus = evidencePoints.length > 1 ? evidencePoints : points;
    if (focus.length > 1) map.fitBounds(focus, { padding: [82, 72], animate: false });
    else if (focus[0]) map.setView(focus[0], 15, { animate: false });
  }, [map, model.locations, model.overlays, revealOverlays]);

  return null;
}

function LocationFeature({ location }: { location: MapLocation }) {
  const sender = location.kind === "sender_reference";
  const delivery = location.kind === "delivery";
  const direction = sender ? "bottom" : "top";
  return (
    <CircleMarker
      center={latLng(location.point)}
      radius={delivery ? 9 : sender ? 7 : 6}
      pathOptions={{
        color: sender ? ROUTE_COLOR : "#ffffff",
        weight: sender ? 2 : 3,
        fillColor: delivery ? "#047857" : sender ? "#ffffff" : ROUTE_COLOR,
        fillOpacity: sender ? 0.35 : 1,
      }}
    >
      <Tooltip permanent direction={direction} offset={[0, -6]}>
        <strong>{location.mapLabel}</strong>
      </Tooltip>
    </CircleMarker>
  );
}

function OverlayFeature({
  feature,
  selected,
  onSelect,
}: {
  feature: MapOverlay;
  selected: boolean;
  onSelect: () => void;
}) {
  if (!feature.point) return null;
  const color = feature.group === "s2-recipients"
    ? ROUTE_COLOR
    : feature.id === "s1-cell-coverage" || (feature.id === "delivery-reported-scan" && feature.evidenceId === null)
      ? CONTEXT_COLOR
      : ALERT_COLOR;
  const eventHandlers = { click: onSelect };
  const tooltip = (
    <Tooltip sticky>
      <strong>{feature.label}</strong><br />
      {feature.detail}<br />
      <span>Source: {feature.provenance}</span>
    </Tooltip>
  );

  if (feature.kind === "line" && feature.points && feature.points.length > 1) {
    return (
      <Polyline
        positions={feature.points.map(latLng)}
        eventHandlers={eventHandlers}
        pathOptions={{
          className: selected ? "map-evidence-selected" : undefined,
          color: ALERT_COLOR,
          dashArray: "10 7",
          // Only evidence connectors are drawn; no navigation path is inferred.
          weight: selected ? 8 : 6,
          opacity: 1,
        }}
      >
        <Tooltip permanent direction="center">{feature.label}</Tooltip>
      </Polyline>
    );
  }

  if (feature.kind === "circle" && feature.radiusMeters) {
    return (
      <Circle
        center={latLng(feature.point)}
        radius={feature.radiusMeters}
        eventHandlers={eventHandlers}
        pathOptions={{
          className: selected ? "map-evidence-selected" : undefined,
          color,
          weight: selected ? 4 : 2,
          fillColor: color,
          fillOpacity: selected ? 0.2 : 0.1,
        }}
      >
        {feature.id.startsWith("s1-") || feature.id.startsWith("s6-") ? (
          <Tooltip permanent direction="top">{feature.label}</Tooltip>
        ) : tooltip}
      </Circle>
    );
  }

  return (
    <CircleMarker
      center={latLng(feature.point)}
      radius={feature.group.startsWith("s2-") ? (selected ? 6 : 3.5) : selected ? 10 : 7}
      eventHandlers={eventHandlers}
      pathOptions={{
        className: selected ? "map-evidence-selected" : undefined,
        color: "#ffffff",
        weight: 2,
        fillColor: color,
        fillOpacity: 0.92,
      }}
    >
      {feature.id.startsWith("s1-") || feature.id.startsWith("s3-") || feature.id === "delivery-reported-scan" ? (
        <Tooltip permanent direction="top">{feature.label}</Tooltip>
      ) : tooltip}
    </CircleMarker>
  );
}

export function ShipmentMapClient({
  model,
  activeLegIndex,
  revealOverlays,
  selectedEvidenceId,
  onSelectEvidence,
}: {
  model: ShipmentMapModel;
  activeLegIndex: number;
  revealOverlays: boolean;
  selectedEvidenceId: string | null;
  onSelectEvidence: (id: string | null) => void;
}) {
  const positioned = model.route.filter((leg): leg is typeof leg & { point: MapPoint } => Boolean(leg.point));
  const current = model.locations.find((location) => location.kind === "delivery")?.point
    ?? positioned.find((leg) => leg.legIndex === activeLegIndex)?.point
    ?? positioned.at(-1)?.point;

  if (!current) {
    return <div className="flex h-[430px] items-center justify-center bg-muted text-sm text-muted-foreground">No coordinate evidence is available.</div>;
  }

  return (
    <div className="relative h-[430px] overflow-hidden rounded-md bg-muted">
      <MapContainer center={latLng(current)} zoom={11} scrollWheelZoom className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Viewport model={model} revealOverlays={revealOverlays} />
        {model.locations.map((location) => <LocationFeature key={location.id} location={location} />)}
        {model.overlays.filter((feature) => revealOverlays || feature.id === "delivery-reported-scan").map((feature) => (
          <OverlayFeature
            key={feature.id}
            feature={feature}
            selected={feature.evidenceId !== null && feature.evidenceId === selectedEvidenceId}
            onSelect={() => onSelectEvidence(feature.evidenceId)}
          />
        ))}
      </MapContainer>

      {revealOverlays && model.notices.length > 0 && (
        <div className="absolute bottom-7 left-3 z-[500] max-w-sm rounded-md border bg-white/95 p-3 shadow-sm">
          {model.notices.map((notice) => (
            <button
              key={notice.id}
              type="button"
              onClick={() => onSelectEvidence(notice.evidenceId)}
              className="block text-left"
            >
              <span className="block text-xs font-semibold">{notice.title}</span>
              <span className="mt-1 block text-xs leading-4 text-muted-foreground">{notice.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

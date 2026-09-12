"use client";

import { useEffect, useRef, useState } from "react";
import { along, length, lineString } from "@turf/turf";
import { useReducedMotion } from "motion/react";
import {
  Circle,
  CircleMarker,
  MapContainer,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import type { MapOverlay, MapPoint, ShipmentMapModel } from "@/lib/workbench";

/**
 * Three kinds of line, told apart WITHOUT reading a tooltip.
 *
 * The route is what happened; the contradiction is the accusation. When both
 * were saturated and the same weight, a viewer could not tell which line was
 * the argument — they read as one network diagram. So the route recedes to a
 * neutral grey and the contradiction is the only coloured, dashed, heavy line
 * on the map. Weight and dash carry it; colour alone would not survive
 * compression or a colour-blind viewer.
 */
const ROUTE_COLOR = "#64748b";
const FUTURE_COLOR = "#cbd5e1";
const ALERT_COLOR = "#c24138";
const CONTEXT_COLOR = "#16778a";

function latLng(point: MapPoint): [number, number] {
  return [point.latitude, point.longitude];
}

function Viewport({
  model,
  activeLegIndex,
  revealOverlays,
}: {
  model: ShipmentMapModel;
  activeLegIndex: number;
  revealOverlays: boolean;
}) {
  const map = useMap();
  const initialized = useRef(false);
  const active = model.route.find((leg) => leg.legIndex === activeLegIndex)?.point;
  const activeLatitude = active?.latitude;
  const activeLongitude = active?.longitude;

  useEffect(() => {
    const points = model.route.flatMap((leg) => (leg.point ? [latLng(leg.point)] : []));
    if (!initialized.current && points.length > 1) {
      map.fitBounds(points, { padding: [36, 36] });
      initialized.current = true;
      return;
    }
    const evidencePoints = revealOverlays
      ? model.overlays.flatMap((feature) => (feature.point ? [latLng(feature.point)] : []))
      : [];
    if (evidencePoints.length > 1) {
      map.fitBounds(evidencePoints, { padding: [54, 54], animate: true, duration: 0.35 });
      return;
    }
    if (activeLatitude !== undefined && activeLongitude !== undefined) {
      map.flyTo([activeLatitude, activeLongitude], 15, { duration: 0.35 });
    }
  }, [activeLatitude, activeLongitude, activeLegIndex, map, model.overlays, model.route, revealOverlays]);

  return null;
}

function AnimatedVehicle({ point }: { point: MapPoint }) {
  const reducedMotion = useReducedMotion();
  const previous = useRef(point);
  const [display, setDisplay] = useState(point);

  useEffect(() => {
    const from = previous.current;
    previous.current = point;
    if (reducedMotion || (from.latitude === point.latitude && from.longitude === point.longitude)) {
      setDisplay(point);
      return;
    }

    const path = lineString([
      [from.longitude, from.latitude],
      [point.longitude, point.latitude],
    ]);
    const distance = length(path);
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / 420);
      const eased = 1 - Math.pow(1 - progress, 3);
      const coordinate = along(path, distance * eased).geometry.coordinates;
      setDisplay({ latitude: coordinate[1], longitude: coordinate[0] });
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [point, reducedMotion]);

  return (
    <CircleMarker
      center={latLng(display)}
      radius={7}
      pathOptions={{ color: "#ffffff", weight: 3, fillColor: ROUTE_COLOR, fillOpacity: 1 }}
    >
      <Tooltip direction="top" offset={[0, -6]}>Current vehicle position</Tooltip>
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
    : feature.id === "s1-cell-coverage"
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
          // Heavier than the heaviest route segment (5), deliberately. This is
          // the only line on the map making a claim.
          weight: selected ? 8 : 6,
          opacity: 1,
        }}
      >
        <Tooltip permanent direction="center">GPS ↔ cell contradiction</Tooltip>
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
      {feature.id.startsWith("s1-") || feature.id.startsWith("s3-") ? (
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
  const current = positioned.find((leg) => leg.legIndex === activeLegIndex)?.point ?? positioned.at(-1)?.point;
  const segments = positioned.slice(1).map((leg, index) => ({ from: positioned[index], to: leg }));

  if (!current) {
    return <div className="flex h-[430px] items-center justify-center bg-muted text-sm text-muted-foreground">No coordinate evidence is available.</div>;
  }

  return (
    <div className="relative h-[430px] overflow-hidden rounded-md border bg-muted">
      <MapContainer center={latLng(current)} zoom={11} scrollWheelZoom className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Viewport model={model} activeLegIndex={activeLegIndex} revealOverlays={revealOverlays} />
        {segments.map(({ from, to }) => (
          <Polyline
            key={`${from.eventId}-${to.eventId}`}
            positions={[latLng(from.point), latLng(to.point)]}
            pathOptions={{
              color: to.legIndex <= activeLegIndex ? ROUTE_COLOR : FUTURE_COLOR,
              weight: to.legIndex === activeLegIndex ? 5 : 3,
              opacity: to.legIndex <= activeLegIndex ? 0.92 : 0.48,
            }}
          />
        ))}
        {positioned.map((leg) => (
          <CircleMarker
            key={leg.eventId}
            center={latLng(leg.point)}
            radius={leg.legIndex === activeLegIndex ? 6 : 4}
            eventHandlers={{ click: () => onSelectEvidence(null) }}
            pathOptions={{ color: "#ffffff", weight: 2, fillColor: leg.legIndex <= activeLegIndex ? ROUTE_COLOR : FUTURE_COLOR, fillOpacity: 1 }}
          >
            <Tooltip>{leg.leg.replaceAll("_", " ")}</Tooltip>
          </CircleMarker>
        ))}
        {revealOverlays && model.overlays.map((feature) => (
          <OverlayFeature
            key={feature.id}
            feature={feature}
            selected={feature.evidenceId !== null && feature.evidenceId === selectedEvidenceId}
            onSelect={() => onSelectEvidence(feature.evidenceId)}
          />
        ))}
        <AnimatedVehicle point={current} />
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

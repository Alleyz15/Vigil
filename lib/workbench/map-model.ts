import { epcsOf, vigilSignalsOf, type EpcisEvent, type GeoPoint } from "@/lib/epcis";
import type { GeneratedScenario, GeneratedWorld } from "@/lib/generate";

export type MapPoint = { latitude: number; longitude: number };

export type RouteLeg = {
  eventId: string;
  legIndex: number;
  leg: string;
  bizStep: string;
  point: MapPoint | null;
};

export type MapLocation = {
  id: string;
  kind: "sender_reference" | "origin_depot" | "destination_depot" | "delivery";
  label: string;
  /** Compact permanent map label; full addresses remain in the journey summary. */
  mapLabel: string;
  detail: string;
  point: MapPoint;
  monitored: boolean;
};

export type MapOverlay = {
  id: string;
  kind: "marker" | "circle" | "line" | "polygon";
  label: string;
  detail: string;
  point: MapPoint | null;
  points?: MapPoint[];
  radiusMeters?: number;
  evidenceId: string | null;
  eventId: string | null;
  group: string;
  provenance: string;
  precision: "observed" | "reported" | "illustrative" | "derived";
};

export type MapNotice = {
  id: string;
  evidenceId: string | null;
  title: string;
  detail: string;
};

export type ShipmentMapModel = {
  route: RouteLeg[];
  /** Semantic places, not turn-by-turn navigation or one marker per scan. */
  locations: MapLocation[];
  overlays: MapOverlay[];
  notices: MapNotice[];
};

function suffix(value: string | undefined): string {
  return value?.split(":").at(-1)?.replaceAll("_", " ") ?? "unknown";
}

function gpsPoint(event: GeneratedScenario["timeline"][number]["event"]): GeoPoint | null {
  return vigilSignalsOf(event)?.gps?.point ?? null;
}

function cellSiteId(event: GeneratedScenario["timeline"][number]["event"]): string | null {
  const cell = vigilSignalsOf(event)?.cell;
  return cell ? `${cell.mcc}-${cell.mnc}-${cell.lac}-${cell.cellId}` : null;
}

function baseRoute(scenario: GeneratedScenario): RouteLeg[] {
  return scenario.timeline.map((built) => ({
    eventId: built.event.eventID,
    legIndex: built.legIndex,
    leg: built.leg,
    bizStep: suffix(built.event.bizStep),
    point: gpsPoint(built.event),
  }));
}

function defaultLocations(route: RouteLeg[]): MapLocation[] {
  const positioned = route.filter((leg): leg is RouteLeg & { point: MapPoint } => Boolean(leg.point));
  const origin = positioned[0];
  const destinationDepot = positioned.find((leg) => leg.leg === "linehaul_arrival") ?? positioned.at(-2);
  const delivery = positioned.find((leg) => leg.leg === "delivery") ?? positioned.at(-1);
  const locations: MapLocation[] = [];

  if (origin) {
    locations.push({
      id: "origin-depot",
      kind: "origin_depot",
      label: "Origin depot",
      mapLabel: "Origin depot",
      detail: "Carrier custody begins here.",
      point: origin.point,
      monitored: true,
    });
  }
  if (destinationDepot) {
    locations.push({
      id: "destination-depot",
      kind: "destination_depot",
      label: "Destination depot",
      mapLabel: "Destination depot",
      detail: "Last-mile dispatch begins here.",
      point: destinationDepot.point,
      monitored: true,
    });
  }
  if (delivery) {
    locations.push({
      id: "delivery",
      kind: "delivery",
      label: "Delivery scan",
      mapLabel: "Delivery",
      detail: "Reported final handoff position.",
      point: delivery.point,
      monitored: true,
    });
  }
  return locations;
}

function s1Overlays(scenario: GeneratedScenario, world: GeneratedWorld): MapOverlay[] {
  const delivery = scenario.timeline.find((built) => built.leg === "delivery");
  if (!delivery) return [];
  const claimed = gpsPoint(delivery.event);
  const siteId = cellSiteId(delivery.event);
  const site = siteId ? world.referenceSites.find((candidate) => candidate.siteId === siteId) : undefined;
  if (!claimed || !site) return [];

  return [
    {
      id: "s1-claimed-position",
      kind: "marker",
      label: "Claimed handset position",
      detail: "The EPCIS event says the handset was here.",
      point: claimed,
      evidenceId: "I1",
      eventId: delivery.event.eventID,
      group: "s1-position-conflict",
      provenance: "synthetic device signal",
      precision: "reported",
    },
    {
      id: "s1-cell-coverage",
      kind: "circle",
      label: "Serving cell context",
      detail:
        "The tower location is synthetic. The 800 m ring is an illustrative macro-cell envelope, not measured coverage.",
      point: { latitude: site.lat, longitude: site.lng },
      radiusMeters: 800,
      evidenceId: "I1",
      eventId: delivery.event.eventID,
      group: "s1-position-conflict",
      provenance: "synthetic reference site; illustrative coverage radius",
      precision: "illustrative",
    },
    {
      id: "s1-position-link",
      kind: "line",
      label: "GPS and cell disagree",
      detail: "The line joins the two independently reported positions; it is not a travelled route.",
      point: claimed,
      points: [claimed, { latitude: site.lat, longitude: site.lng }],
      evidenceId: "I1",
      eventId: delivery.event.eventID,
      group: "s1-position-conflict",
      provenance: "derived from two synthetic evidence coordinates",
      precision: "derived",
    },
  ];
}

function s6Overlays(scenario: GeneratedScenario): MapOverlay[] {
  const delivery = scenario.timeline.find((built) => built.leg === "delivery");
  if (!delivery) return [];
  const gps = vigilSignalsOf(delivery.event)?.gps;
  if (!gps) return [];

  return [
    {
      id: "s6-gps-uncertainty",
      kind: "circle",
      label: `${gps.point.accuracyMeters} m reported GPS uncertainty`,
      detail: "The device reports degraded precision, so location checks are not treated as clean evidence.",
      point: gps.point,
      radiusMeters: gps.point.accuracyMeters,
      evidenceId: null,
      eventId: delivery.event.eventID,
      group: "s6-degraded-fix",
      provenance: "synthetic device signal",
      precision: "reported",
    },
  ];
}

function s2Overlays(scenario: GeneratedScenario): MapOverlay[] {
  const recipientsByEpc = new Map(scenario.parcels.map((parcel) => [parcel.epc, parcel.recipientPoint]));
  const overlays: MapOverlay[] = [];

  for (const built of scenario.timeline) {
    const point = gpsPoint(built.event);
    if (point) {
      overlays.push({
        id: `s2-scan-${built.legIndex}`,
        kind: "marker",
        label: `Scan ${built.legIndex + 1}`,
        detail: "Synthetic handset scan position.",
        point,
        evidenceId: null,
        eventId: built.event.eventID,
        group: "s2-scans",
        provenance: "synthetic device signal",
        precision: "reported",
      });
    }

    const epc = epcsOf(built.event)[0];
    const recipient = epc ? recipientsByEpc.get(epc) : undefined;
    if (recipient) {
      overlays.push({
        id: `s2-recipient-${built.legIndex}`,
        kind: "marker",
        label: `Recipient ${built.legIndex + 1}`,
        detail: "Synthetic parcel recipient location.",
        point: recipient,
        evidenceId: null,
        eventId: built.event.eventID,
        group: "s2-recipients",
        provenance: "synthetic parcel record",
        precision: "observed",
      });
    }
  }

  return overlays;
}

function s3Projection(scenario: GeneratedScenario): Pick<ShipmentMapModel, "overlays" | "notices"> {
  const original = scenario.replay
    ? scenario.timeline.find((built) => built.event.eventID === scenario.replay?.event.event.eventID)
    : undefined;
  const point = original ? gpsPoint(original.event) : null;
  if (!original || !scenario.replay || !point) return { overlays: [], notices: [] };

  return {
    overlays: [
      {
        id: "s3-event-reuse",
        kind: "marker",
        label: "One event ID, two payloads",
        detail: "The second payload changes the EPC while retaining the event ID and recorded position.",
        point,
        evidenceId: "H4",
        eventId: original.event.eventID,
        group: "s3-event-reuse",
        provenance: "synthetic EPCIS submissions",
        precision: "reported",
      },
    ],
    notices: [
      {
        id: "s3-reuse-same-position",
        evidenceId: "H4",
        title: "Payload changed; position did not",
        detail: "The generated attack changes the EPC, not the GPS claim. No second position is drawn because none exists in the evidence.",
      },
    ],
  };
}

function deliveryProjection(
  event: EpcisEvent,
  flags: string[],
  reference: MapPoint | undefined,
): Pick<ShipmentMapModel, "overlays" | "notices"> {
  const overlays: MapOverlay[] = [];
  const notices: MapNotice[] = [];
  const point = gpsPoint(event);
  // Geometry reports the existing result. Coordinate separation never creates risk.
  const spatialFlags = ["I10", "I11"].filter((id) => flags.includes(id));
  const evidenceId = spatialFlags[0] ?? null;

  if (!point) {
    notices.push({
      id: "delivery-gps-unavailable",
      evidenceId,
      title: "Delivery GPS unavailable",
      detail: "The submitted event has no GPS fix. No delivery scan position or evidence connector can be drawn.",
    });
    return { overlays, notices };
  }

  if (reference && point.latitude === reference.latitude && point.longitude === reference.longitude) {
    return { overlays, notices };
  }

  overlays.push({
    id: "delivery-reported-scan",
    kind: "marker",
    label: "Reported delivery scan",
    detail: "GPS position reported in the submitted event; separate from the recorded recipient reference.",
    point,
    evidenceId,
    eventId: event.eventID,
    group: "delivery-reference",
    provenance: "submitted EPCIS GPS signal",
    precision: "reported",
  });

  if (!reference) {
    notices.push({
      id: "delivery-reference-unavailable",
      evidenceId,
      title: "Delivery reference unavailable",
      detail: "No recorded recipient reference coordinate is available. The submitted scan is shown without an evidence connector.",
    });
    return { overlays, notices };
  }

  for (const id of spatialFlags) {
    overlays.push({
      id: `delivery-reference-${id}`,
      kind: "line",
      label: "GPS and recorded recipient reference disagree",
      detail: `${id} was emitted for this submission. This connector compares evidence positions; it is not a travelled route.`,
      point,
      points: [point, reference],
      evidenceId: id,
      eventId: event.eventID,
      group: "delivery-reference",
      provenance: "submitted EPCIS GPS signal and recorded recipient reference",
      precision: "derived",
    });
  }
  return { overlays, notices };
}

/**
 * Project generated evidence into display geometry. This module never fills a
 * missing coordinate: unsupported evidence becomes a notice instead.
 */
export function buildShipmentMapModel(
  scenario: GeneratedScenario,
  world: GeneratedWorld,
  options: { locations?: MapLocation[]; deliveryEvent?: EpcisEvent; deliveryFlags?: string[] } = {},
): ShipmentMapModel {
  const route = baseRoute(scenario);
  let locations = options.locations ?? defaultLocations(route);
  if (options.deliveryEvent) {
    const event = options.deliveryEvent;
    const matching = route.findIndex((leg) => leg.eventId === event.eventID);
    const index = matching >= 0 ? matching : route.findLastIndex((leg) => leg.leg === "delivery");
    if (index >= 0) {
      route[index] = { ...route[index], eventId: event.eventID, bizStep: suffix(event.bizStep), point: gpsPoint(event) };
      // Scenario-specific context must use the same submitted evidence as the endpoint.
      scenario = { ...scenario, timeline: scenario.timeline.map((built, i) => i === index ? { ...built, event } : built) };
    }
    if (!options.locations) {
      const epc = epcsOf(event)[0];
      const recipient = scenario.parcels.find((parcel) => parcel.epc === epc)?.recipientPoint;
      locations = locations.filter((location) => location.kind !== "delivery");
      if (recipient) locations.push({
        id: "delivery", kind: "delivery", label: "Recorded recipient reference", mapLabel: "Recorded reference",
        detail: "Recipient point in the parcel record, independent of the submitted GPS fix.",
        point: recipient, monitored: true,
      });
    }
  }
  const model: ShipmentMapModel = {
    route,
    locations,
    overlays: [],
    notices: [],
  };

  if (scenario.id === "S1") model.overlays.push(...s1Overlays(scenario, world));
  if (scenario.id === "S2") model.overlays.push(...s2Overlays(scenario));
  if (scenario.id === "S3") {
    const replay = s3Projection(scenario);
    model.overlays.push(...replay.overlays);
    model.notices.push(...replay.notices);
  }
  if (scenario.id === "S4") {
    model.notices.push({
      id: "s4-scope-not-spatial",
      evidenceId: "H2",
      title: "Mandate scope is not geographic",
      detail:
        "This mandate authorises an EPC prefix, not a map polygon. H2 found a foreign EPC. Drawing a geographic boundary would invent precision the authorisation record does not contain.",
    });
  }
  if (scenario.id === "S6") model.overlays.push(...s6Overlays(scenario));

  if (options.deliveryEvent) {
    const delivery = deliveryProjection(
      options.deliveryEvent,
      options.deliveryFlags ?? [],
      locations.find((location) => location.kind === "delivery")?.point,
    );
    model.overlays.push(...delivery.overlays);
    model.notices.push(...delivery.notices);
  }

  return model;
}

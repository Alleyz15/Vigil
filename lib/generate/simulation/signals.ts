import { EpcisEvent, vigilSignalsOf, type GeoPoint } from "@/lib/epcis";
import { distanceMeters } from "@/lib/engine/geo";
import type { RandomSimulationConfig } from "@/lib/simulation/config";
import { isoAt, jitterPoint, type Rng } from "../rng";
import { buildLegEvent, type BuiltEvent, type LegName, type LegOverrides, type LegSpec } from "../timeline";
import type { GeneratedCourier, GeneratedParcel, GeneratedWorld } from "../world";
import { HUBS } from "../world";
import { ASSUMPTIONS as A } from "./assumptions";
import { simulationStream } from "./streams";
import type { SimulationCondition } from "./types";

const uniform = (rng: Rng, band: readonly [number, number]) => rng.float(...band);
const logUniform = (rng: Rng, band: readonly [number, number]) => Math.exp(rng.float(Math.log(band[0]), Math.log(band[1])));

/** Stable across both bootstrap and current timelines from this device. */
export function deviceClockSeconds(config: RandomSimulationConfig, courierId: string, deviceId: string): number {
  const rng = simulationStream(config, JSON.stringify(["clock", courierId, deviceId]));
  return Math.round(uniform(rng, rng.chance(A.clockErrorProbability) ? A.clockErrorSeconds : A.clockSeconds));
}

export type SimulationTimelineArgs = {
  config: RandomSimulationConfig;
  world: GeneratedWorld;
  courier: GeneratedCourier;
  parcel: GeneratedParcel;
  legs: LegSpec[];
  startMs: number;
  idPrefix: string;
  scan?: GeoPoint;
  hubs?: { origin: GeoPoint; destination: GeoPoint };
  overrides?: Partial<Record<LegName, LegOverrides>>;
  /** Explicit observations from the existing registry, never inferred online. */
  registeredSites?: { cell: string; wifi: string };
};

export function buildSimulationTimeline(args: SimulationTimelineArgs): {
  timeline: BuiltEvent[]; legs: LegSpec[]; conditions: SimulationCondition[];
} {
  const { config, world, courier, parcel, startMs, idPrefix } = args;
  const registeredCell = args.registeredSites?.cell;
  const registeredWifi = args.registeredSites?.wifi;
  const hasCell = world.referenceSites.some((site) => site.kind === "cell" && site.siteId === registeredCell);
  const hasWifi = world.referenceSites.some((site) => site.kind === "wifi" && site.siteId === registeredWifi);
  // A server-minted shipment UUID allocates identities; it must never redraw
  // the physical facts for otherwise identical confirmed inputs/context.
  const stream = (name: string) => simulationStream(config, JSON.stringify([courier.courierId, name]));
  const behavior = stream("behavior");
  const conditions: SimulationCondition[] = [];
  const cause = (code: string, label: string) => {
    const selected = behavior.chance(A.behaviorProbability);
    if (selected) conditions.push({ source: "behavior", code, label });
    return selected;
  };
  const movedClaim = cause("displaced_scan", "Simulated scan position displaced from the stop");
  const mock = cause("mock_provider", "Device reports a simulated location provider");
  const still = cause("stationary_motion", "Motion telemetry held stationary during the claimed journey");
  const compressed = cause("compressed_travel", "Delivery timestamp batched shortly after departure");
  const replacement = cause("unbound_handset", "Scan claims a replacement handset without changing the courier binding");
  const frozenBattery = cause("frozen_battery", "Battery telemetry held constant during the route");
  const oldPhoto = cause("reused_photo", "Delivery photo reused from an earlier time");
  const partialPod = cause("incomplete_pod", "One or more proof artifacts omitted");
  const wrongOtp = cause("otp_channel_conflict", "Verifier transaction belongs to a different recipient channel");
  const weakLabels = cause("basic_attestation", "Handset presents only basic recognition assurance");

  const legs = args.legs.map((leg) => ({ ...leg }));
  const deliveryIndex = legs.findIndex((leg) => leg.name === "delivery");
  if (compressed && deliveryIndex > 0) {
    legs[deliveryIndex].offsetMinutes = legs[deliveryIndex - 1].offsetMinutes +
      stream("travel").int(...A.compressedTravelSeconds) / 60;
  }
  const physicalPoints = legs.map((leg) => leg.where === "recipient"
    ? args.scan ?? parcel.recipientPoint
    : leg.where === "origin_hub" ? args.hubs?.origin ?? HUBS.kl : args.hubs?.destination ?? HUBS.shahAlam);
  let traveledKm = 0;
  const seenDevices = new Set<string>();
  const timeline = legs.map((leg, index) => {
    const delivery = leg.name === "delivery";
    const rng = stream(`${leg.name}:gps`);
    const degraded = rng.chance(A.degradedGpsProbability);
    const accuracy = degraded ? logUniform(rng, A.degradedAccuracyMeters) : uniform(rng, A.accuracyMeters);
    if (degraded) conditions.push({ source: "environment", code: `${leg.name}:degraded_gps`, label: `Degraded GPS reception at ${leg.name}` });
    const truePoint = physicalPoints[index];
    // One point and one uncertainty radius feed every position-dependent rule.
    const point = jitterPoint(rng, truePoint, delivery && movedClaim
      ? uniform(stream("claimed-displacement"), A.claimedDisplacementMeters)
      : accuracy * uniform(rng, A.actualErrorMultiplier));
    const deviceId = args.overrides?.[leg.name]?.deviceId ??
      (replacement && index >= Math.floor(legs.length / 2) ? `${courier.deviceId}-replacement` : courier.deviceId);
    const trueMs = Math.floor((startMs + leg.offsetMinutes * 60_000) / 1000) * 1000;
    const clock = deviceClockSeconds(config, courier.courierId, deviceId);
    if (!seenDevices.has(deviceId)) {
      conditions.push({ source: "environment", code: `clock:${deviceId}`, label: `${deviceId} clock offset ${clock} seconds` });
      seenDevices.add(deviceId);
    }
    const eventMs = trueMs + clock * 1000;
    const upload = stream(`${leg.name}:upload`);
    const queued = upload.chance(A.queuedUploadProbability);
    const latency = uniform(upload, A.uploadSeconds);
    const uploadSeconds = queued ? logUniform(upload, A.queuedUploadSeconds) : latency;
    if (queued) conditions.push({ source: "environment", code: `${leg.name}:queued_upload`, label: `Offline upload queue at ${leg.name}` });
    const deltaKm = index === 0 ? 0 : distanceMeters(physicalPoints[index - 1], truePoint) / 1000;
    traveledKm += deltaKm;
    const elapsedSeconds = index === 0 ? 0 : (leg.offsetMinutes - legs[index - 1].offsetMinutes) * 60;
    const speed = elapsedSeconds > 0 ? deltaKm * 1000 / elapsedSeconds : 0;
    const proof = stream(`${leg.name}:proof`);
    const integrity = stream(`${leg.name}:integrity`).next();
    const sampledIntegrityVerdict = integrity < A.integrityPassedProbability ? "passed"
      : integrity < A.integrityPassedProbability + A.integrityFailedProbability ? "failed" : "unevaluated";
    const explicitIntegrityFailure = args.overrides?.[leg.name]?.integrityFailed;
    const integrityVerdict = explicitIntegrityFailure === undefined ? sampledIntegrityVerdict
      : explicitIntegrityFailure ? "failed" : "passed";
    if (integrityVerdict !== "passed") conditions.push({ source: integrityVerdict === "failed" ? "behavior" : "environment", code: `${leg.name}:integrity_${integrityVerdict}`, label: `Simulated integrity service returned ${integrityVerdict} at ${leg.name}` });
    const overrides: LegOverrides = {
      scanPoint: point, gpsAccuracyMeters: accuracy,
      eventTime: isoAt(eventMs), recordTime: isoAt(trueMs + uploadSeconds * 1000),
      mockLocation: delivery && mock,
      batteryPercent: frozenBattery ? A.initialBatteryPercent : Math.max(A.minimumBatteryPercent,
        A.initialBatteryPercent - leg.offsetMinutes * A.batteryPerMinute - traveledKm * A.batteryPerKm),
      batteryCharging: stream(`${leg.name}:battery`).chance(A.chargingProbability),
      photoExifCaptureTime: isoAt(eventMs - uniform(proof, oldPhoto ? A.reusedPhotoSeconds : A.photoSeconds) * 1000),
      integrityFailed: integrityVerdict === "failed",
      deviceRecognitionVerdicts: weakLabels ? ["MEETS_BASIC_INTEGRITY"] : [courier.requiredRecognitionVerdict],
      otpRecipientChannel: wrongOtp ? `${parcel.recipientPhone}-other-channel` : parcel.recipientPhone,
      ...args.overrides?.[leg.name],
      deviceId,
      // Absence is structural. Even an override cannot borrow an arbitrary ID.
      omitCell: !hasCell || args.overrides?.[leg.name]?.omitCell === true,
      omitWifi: !hasWifi || args.overrides?.[leg.name]?.omitWifi === true,
      cellSiteId: hasCell ? registeredCell : undefined, wifiBssid: hasWifi ? registeredWifi : undefined,
    };
    const built = buildLegEvent({ world, courier, parcel, leg, legIndex: index, startMs, rng: stream(`${leg.name}:event`), eventIdSeed: `${idPrefix}-${leg.name}`, hubs: args.hubs, overrides });
    const signals = vigilSignalsOf(built.event)!;
    // A claimed handset cannot create or weaken its own enrollment authority.
    const enrolled = world.couriers.find((registered) => registered.deviceId === signals.deviceId);
    if (built.identity) {
      if (enrolled && built.identity.deviceEnrollment) {
        built.identity.deviceEnrollment.courierId = enrolled.courierId;
        built.identity.deviceEnrollment.requiredRecognitionVerdict = enrolled.requiredRecognitionVerdict;
      } else {
        delete built.identity.deviceEnrollment;
      }
    }
    signals.gps!.speedMps = speed;
    const movement = stream(`${leg.name}:motion`);
    const stationary = args.overrides?.[leg.name]?.motionStationary ?? (delivery && still || speed === 0);
    const mean = uniform(movement, stationary ? A.stillDeviation : A.movingDeviation);
    signals.motion = { windowSeconds: A.motionWindowSeconds, meanAbsDeviationMs2: mean, maxAbsDeviationMs2: mean * A.peakDeviationMultiplier };
    signals.integrity!.verdict = integrityVerdict;
    if (delivery && partialPod && signals.pod) {
      const missing = proof.pick(A.omittedProofArtifacts);
      if (missing === "all") delete signals.pod;
      else if (missing === "photo") { delete signals.pod.photoSha256; delete signals.pod.photoExifCaptureTime; }
      else if (missing === "signature") delete signals.pod.signatureSha256;
      else { delete signals.pod.otp; signals.pod.otpVerified = false; }
    }
    if (built.identity?.otpChallenge) {
      // Independent server records keep true time even when the device drifts.
      const otp = built.identity.otpChallenge;
      otp.issuedAt = isoAt(trueMs - 5 * 60_000);
      otp.expiresAt = isoAt(trueMs + 5 * 60_000);
      otp.verifiedAt = isoAt(trueMs - 10_000);
      const status = stream(`${leg.name}:otp-status`).pick(A.otpStatuses);
      otp.deliveryStatus = status;
      if (status !== "delivered") conditions.push({ source: "environment", code: `${leg.name}:otp_${status}`, label: `Independent OTP delivery status ${status}` });
      if (!signals.pod?.otp) delete built.identity.otpChallenge;
    }
    // Re-parse every enriched field; raw and parsed event describe identical facts.
    const raw = { ...built.event, sensorElementList: [{ "vigil:signals": signals }] };
    return { ...built, raw, event: EpcisEvent.parse(raw) };
  });
  return { timeline, legs, conditions };
}

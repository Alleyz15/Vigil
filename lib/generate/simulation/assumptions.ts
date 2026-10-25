/**
 * signals-v1 ASSUMPTIONS, NOT field measurements. See ASSUMPTIONS.md.
 * These bands describe devices and behavior; they do not read scoring policy.
 */
export const ASSUMPTIONS = {
  // ASSUMPTION: each deliberately simulated behavior is independently present
  // with this probability. This is an exploration mixture, not prevalence.
  behaviorProbability: 0.2,
  // ASSUMPTION: 30% of handset clocks have a large configuration error.
  clockErrorProbability: 0.3,
  // ASSUMPTION: ordinary clock offset seconds; misconfiguration seconds.
  clockSeconds: [-45, 45],
  clockErrorSeconds: [-5400, 5400],
  // ASSUMPTION: 30% degraded fixes; log-uniform reported radius 20..400m,
  // independent actual error multiplier 0.3..3; ordinary radius 5..25m.
  degradedGpsProbability: 0.3,
  accuracyMeters: [5, 25],
  degradedAccuracyMeters: [20, 400],
  actualErrorMultiplier: [0.3, 3],
  // ASSUMPTION: a fabricated location can be anywhere 50..8000m away.
  claimedDisplacementMeters: [50, 8000],
  // ASSUMPTION: batched scan interval 20..120 whole seconds, independent of route distance.
  compressedTravelSeconds: [20, 120],
  // ASSUMPTION: 20% queued uploads, log-uniform 30s..36h; normal 8..90s.
  queuedUploadProbability: 0.2,
  uploadSeconds: [8, 90],
  queuedUploadSeconds: [30, 129600],
  // ASSUMPTION: aged photo 1min..24h; ordinary walk to vehicle 10..120s.
  photoSeconds: [10, 120],
  reusedPhotoSeconds: [60, 86400],
  // ASSUMPTION: 70% passed, 15% failed, 15% unavailable attestation service.
  integrityPassedProbability: 0.7,
  integrityFailedProbability: 0.15,
  // ASSUMPTION: independent OTP service is delivered 60%, failed 20%,
  // unknown 20%; missing proof chooses photo/OTP/signature/all uniformly.
  otpStatuses: ["delivered", "delivered", "delivered", "failed", "unknown"],
  omittedProofArtifacts: ["photo", "otp", "signature", "all"],
  // ASSUMPTION: charging on 15% of scans; active device consumes battery with
  // elapsed minutes and distance, starting at 92%, with a 5% floor.
  // Bootstrap history is one unplugged round with the same consumption model.
  chargingProbability: 0.15,
  initialBatteryPercent: 92,
  batteryPerMinute: 0.015,
  batteryPerKm: 0.12,
  minimumBatteryPercent: 5,
  // ASSUMPTION: moving-window acceleration variation and still-device noise.
  movingDeviation: [0.2, 0.9],
  stillDeviation: [0.005, 0.04],
  motionWindowSeconds: 60,
  // ASSUMPTION: window peak deviation is twice its mean summary value.
  peakDeviationMultiplier: 2,
  // ASSUMPTION: four history behaviors equally likely; a round has 32..48
  // parcels, subject to actual parcel availability. No synthetic score draws.
  historyCount: [32, 48],
  // ASSUMPTION: normal stops 8..24min plus driving at 35km/h; building
  // batch scans (burst and recurring-signals profiles) take 10..60s.
  historyStopSeconds: [480, 1440],
  historyBurstSeconds: [10, 60],
  historyDrivingKmh: 35,
  // ASSUMPTION: last historical delivery three hours before current start;
  // this leaves both devices' clock offsets before the current timeline.
  historyLeadMs: 10800000,
  // ASSUMPTION: burst scans within a 15m building; clumped van within 8m.
  buildingRadiusMeters: 15,
  vanRadiusMeters: 8,
  // ASSUMPTION: complaints are 2% for a normal round and 25% for explicitly
  // simulated anomalous behavior. They are generated outcome IDs, not rates.
  normalDisputeProbability: 0.02,
  anomalousDisputeProbability: 0.25,
} as const;

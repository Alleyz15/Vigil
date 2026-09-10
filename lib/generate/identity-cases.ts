import type { GeneratedScenario, ScenarioContext } from "./scenarios/types";
import { buildWarmup } from "./scenarios/warmup";
import { buildTimeline } from "./timeline";
import { prefixFor } from "./world";

/** Identity cases are experiment fixtures, not additions to the S0-S6 demo picker. */
export type IdentityCaseId = "recipient_channel_substitution" | "replacement_weak_handset";

export type GeneratedIdentityCase = {
  id: IdentityCaseId;
  label: string;
  scenario: GeneratedScenario;
};

export function buildIdentityCase(
  id: IdentityCaseId,
  ctx: ScenarioContext,
): GeneratedIdentityCase {
  const courier = ctx.world.couriers[0];
  const parcels = ctx.world.parcels.filter((parcel) => parcel.epc.startsWith(prefixFor(0)));
  const parcel = parcels[0];
  const rng = ctx.rng.derive(`identity-${id}`);
  const warmup = buildWarmup({
    world: ctx.world,
    courier,
    parcels: parcels.slice(45),
    rng,
    startMs: ctx.startMs - 6 * 60 * 60 * 1000,
    idPrefix: `identity-${id}`,
    noiseLevel: 0,
  });

  const deliveryOverride =
    id === "recipient_channel_substitution"
      ? { otpRecipientChannel: alternateChannel(parcel.recipientPhone) }
      : {
          deviceId: `${courier.deviceId}-replacement`,
          deviceRecognitionVerdicts: ["MEETS_BASIC_INTEGRITY" as const],
          requiredRecognitionVerdict: "MEETS_DEVICE_INTEGRITY" as const,
        };

  const scenario: GeneratedScenario = {
    // Intentionally not registered as S7/S8: these are experiment cases, not
    // additions to the frozen public scenario picker.
    id: "S0",
    title: id === "recipient_channel_substitution" ? "OTP channel substitution" : "Weak replacement handset",
    description:
      id === "recipient_channel_substitution"
        ? "The verifier delivered the OTP to a channel other than the parcel's registered recipient channel."
        : "A known replacement handset is unbound to this courier and presents weaker assurance than its enrollment requires.",
    courier,
    parcels: [parcel],
    warmup,
    timeline: buildTimeline({
      world: ctx.world,
      courier,
      parcel,
      startMs: ctx.startMs,
      rng,
      idPrefix: `identity-${id}`,
      overrides: { delivery: deliveryOverride },
    }),
    disputedEventIds: [],
    expectation: {
      exceptionAtLeg: "delivery",
      decision: "flag",
      expectFlags: id === "recipient_channel_substitution" ? ["I15"] : ["I6", "I16"],
      axis: "single_event",
    },
  };

  return {
    id,
    label: id === "recipient_channel_substitution" ? "OTP channel substitution" : "Weak replacement handset",
    scenario,
  };
}

function alternateChannel(channel: string): string {
  const last = Number(channel.at(-1) ?? "0");
  return `${channel.slice(0, -1)}${(last + 1) % 10}`;
}

import type { Decision } from "@/lib/ledger/types";
import type { BuiltEvent, LegName } from "../timeline";
import type { GeneratedCourier, GeneratedParcel, GeneratedWorld } from "../world";
import type { Episodes, NoiseLevel } from "../noise";
import type { Rng } from "../rng";

/**
 * A scenario is a whole timeline with, at most, one thing wrong at one leg.
 *
 * "From normal activity to a meaningful exception" is the brief's phrase. The
 * normal part is not padding: without it there is nothing for the exception to
 * depart from, and half the engine has no history to compare against.
 */

export type ScenarioId = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6";

/** What a scenario expects to happen, and where. */
export type ScenarioExpectation = {
  /** The leg the exception appears at, or null when nothing is wrong. */
  exceptionAtLeg: LegName | null;
  /** The decision expected at that leg (or at every leg, when there is none). */
  decision: Decision;
  /** Flag ids that must appear on the sealed verdict at the exception leg. */
  expectFlags?: string[];
  /** Flag ids that must NOT appear — the false-positive guards. */
  forbidFlags?: string[];
  /** Whether the exception is expected on axis 1, axis 2, or neither. */
  axis: "single_event" | "pattern" | "none";
};

export type ScenarioContext = {
  world: GeneratedWorld;
  rng: Rng;
  /** Milliseconds since epoch for the first leg of the main timeline. */
  startMs: number;
  /**
   * How rough the world is, 0-3. Defaults to 0, the control: no environmental
   * noise and no randomness drawn, so every expectation below stays valid
   * without rejustification. Experiment 3 sweeps it.
   */
  noiseLevel?: NoiseLevel;
};

/**
 * A generated scenario: the timelines to run, in order, and what to expect.
 *
 * `warmup` runs first and exists so the courier is not cold-start. Without it
 * every scenario lands in the co-sign path and S0 cannot demonstrate a clean
 * accept — the pattern axis has no history to be clean ABOUT.
 */
export type GeneratedScenario = {
  id: ScenarioId;
  title: string;
  /** One paragraph, for DATASET.md and the demo script. */
  description: string;
  courier: GeneratedCourier;
  parcels: GeneratedParcel[];
  /** Prior sealed handoffs, so the courier clears the cold-start floor. */
  warmup: BuiltEvent[];
  /** The scenario's own timeline(s). */
  timeline: BuiltEvent[];
  /** Event ids whose deliveries the recipient disputed. */
  disputedEventIds: string[];
  expectation: ScenarioExpectation;
  /**
   * The environmental episodes the noise model drew for this shipment.
   *
   * GROUND TRUTH FOR THE EXPERIMENTS. Experiment 3 reports the false-positive
   * rate per episode — of the shipments that lost a scan, how many alerted —
   * and inferring the episode back out of the events would mean attributing an
   * alert using the same measurement the detector made. Undefined at level 0,
   * and for S2, which composes its legs itself.
   */
  noiseEpisodes?: Episodes;
  /** A second submission of an already-seen eventID, for S3. */
  replay?: { event: BuiltEvent; expectAbort: string };
};

export type ScenarioBuilder = (ctx: ScenarioContext) => GeneratedScenario;

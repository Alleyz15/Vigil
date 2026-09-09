import { z } from "zod";
import type { EpcisEvent, GeoPoint } from "@/lib/epcis";
import type { CourierMandate } from "@/lib/mandate/schema";
import type { GateResult } from "@/lib/gate/types";
import type { VerificationResult } from "@/lib/credential/types";
import { type Resolution, emptyResolution } from "@/lib/assemble/types";
import type { TraceFrame } from "./trace";
import type { EngineResult, Flag } from "@/lib/engine/types";
import type { PatternOutcome } from "@/lib/pattern/types";
import type { Decision, Verdict } from "@/lib/ledger/types";
import type { WeatherObservation } from "@/lib/weather";
import type { RerouteOutcome } from "@/lib/reroute";

/**
 * The context object the state machine threads through its eight nodes.
 *
 * There is no framework here on purpose. Eight nodes over one typed object is a
 * switch statement; a graph library would add a layer to explain to a judge
 * without removing one from the code.
 */

// Imported AND re-exported: a bare `export type { Node } from ...` does not
// bring the name into this module's scope, and `Node` would silently resolve to
// the DOM's global Node interface instead.
import type { Node } from "./nodes-list";
export { NODES } from "./nodes-list";
export type { Node };

/**
 * The closed set of optional tools the LLM may select at `plan`.
 *
 * A zod enum, not a string: the model picks from a fixed list or the parse
 * fails. It cannot invent a tool, and it cannot reach anything not named here.
 */
export const ToolName = z.enum([
  "fetch_route_history",
  "check_traffic_weather",
  "lookup_recipient_history",
]);
export type ToolName = z.infer<typeof ToolName>;

/** What `plan` is allowed to return. At most two tools; zero is a valid plan. */
export const ToolPlan = z.strictObject({
  tools: z.array(ToolName).max(2),
  /** Free text, for the SSE stream only. Never read by the engine. */
  rationale: z.string().optional(),
});
export type ToolPlan = z.infer<typeof ToolPlan>;

/**
 * One scored contradiction, re-exported from the engine so the agent and the
 * engine cannot drift apart. Evidence carries field AND value, because "the
 * evidence behind the decision" means showing the operator what the values were,
 * not just which fields were consulted.
 */
export type { Evidence, Flag } from "@/lib/engine/types";

/** Axis 1: single-event contradiction. Produced by `verify`. */
export type InconsistencyResult = {
  score: number;
  flags: Flag[];
  /** Set when a hard check failed. A hard failure aborts; it is never partial. */
  abortCode?: string;
};

/** Axis 2: per-courier rolling pattern. Produced by `fetch_history`. */
export type PatternResult = {
  score: number;
  flags: Flag[];
  /** How many prior events the window actually contained. Thin history is a caveat. */
  sampleSize: number;
};

/**
 * A frame emitted to the operator console over SSE.
 * The contract lives in ./trace.ts and is frozen from session 4.
 */
export type { TraceFrame } from "./trace";

/** Everything the machine accumulates. Nodes read it and write their own slice. */
export type AgentContext = {
  /** Raw input as received, before validation. */
  readonly input: unknown;

  /** parse */
  event?: EpcisEvent;
  parseError?: string;
  /**
   * True when the client sent a recordTime of its own. The server authors that
   * field; a device supplying it is claiming to know when the server received
   * something it has not yet sent, which the engine treats as a signal.
   */
  recordTimeSuppliedByClient?: boolean;

  /** lookup */
  parcel?: {
    epc: string;
    known: boolean;
    recipientAddress?: string;
    declaredValueSen?: number;
    recipientPoint?: GeoPoint;
  };
  courier?: {
    courierId: string;
    known: boolean;
    boundDeviceId?: string | null;
    /** SPKI DER base64, for verifying the courier half of the credential. */
    publicKey?: string;
  };
  /**
   * The courier's authorisation. `value` is the full validated object the
   * engine and gate read; it is absent when no active mandate exists OR when
   * the stored JSON could not be parsed. Unreadable authorisation is treated as
   * no authorisation - see CLAUDE.md on failing closed.
   */
  mandate?: { known: boolean; value?: CourierMandate };
  /** Set when the parcel or courier is unrecognised. Unknown is high risk, not neutral. */
  unknownEntityRisk?: "high";

  /** plan */
  plan?: ToolPlan;
  /** True when the deterministic heuristic produced the plan (LLM off, failed, or lite mode). */
  planFromHeuristic?: boolean;
  /** Why a model's plan was refused, when one was asked and refused. */
  planRejection?: string;

  /** verify - axis 1 */
  inconsistency?: InconsistencyResult;
  /** The engine's full result, handed to the gate unchanged. */
  engineResult?: EngineResult;
  /** Ledger outcome. An aborted or duplicated event short-circuits the run. */
  ledger?:
    | { status: "recorded"; seq: number }
    | { status: "noop"; seq: number; verdict: Verdict }
    | { status: "aborted"; code: "EVENT_ID_REUSE" };

  /** fetch_history - axis 2 */
  pattern?: PatternResult;
  /** The pattern engine's full outcome, handed to the gate unchanged. */
  patternOutcome?: PatternOutcome;
  /**
   * True when the courier has too little history for ANY pattern claim.
   * Distinct from a low score: the gate must never read cold start as evidence
   * of good behaviour. See CLAUDE.md.
   */
  patternColdStart?: boolean;

  /**
   * Evidence coverage per axis, as reported by the engines. Rendered for the
   * operator as "8 of 14 checks evaluable".
   */
  coverage?: {
    inconsistency?: { evaluated: number; total: number; line: string };
    pattern?: { evaluated: number; total: number; line: string };
  };

  /** external_context — normalised fields only; never raw provider prose. */
  externalContext?:
    | {
        status: "available";
        source: "open-meteo-archive";
        retrieval: "cache" | "network";
        summary: string;
        observation: WeatherObservation;
      }
    | {
        status: "unavailable";
        source: "open-meteo-archive";
        summary: string;
        reason: string;
      };

  /** gate — credential verification, run against the gate's own threshold */
  credential?: VerificationResult;

  /** gate */
  decision?: Decision;
  requiresCosign?: boolean;
  verdict?: Verdict;
  gateResult?: GateResult;
  /** Post-gate next action. It cannot feed back into the sealed verdict. */
  reroute?: RerouteOutcome;

  /** explain */
  explanation?: string;
  /** True when the structured flag list produced the explanation. */
  explanationFromFallback?: boolean;
  /** Why a model's explanation was refused, when one was asked and refused. */
  explanationRejection?: string;
  /** Evidence ids the model cited that this run never collected. */
  hallucinatedCitations?: string[];

  /**
   * What the assemblers could and could not resolve. The single source for the
   * operator's evidence-coverage line - see lib/assemble/types.ts.
   */
  resolution: Resolution;

  /** Trace of every node, for the SSE stream and the audit trail. */
  trace: TraceFrame[];
  /** Set when the run ended early. */
  halted?: { at: Node; reason: string };
};

/** A fresh context for one event. */
export function createContext(input: unknown): AgentContext {
  return { input, trace: [], resolution: emptyResolution() };
}

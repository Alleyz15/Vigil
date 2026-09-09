import { extractJson, type LlmProvider, type LlmRequest } from "@/lib/llm";
import type { AgentContext } from "@/lib/agent/context";
import { vigilSignalsOf } from "@/lib/epcis";
import { Decision } from "@/lib/ledger";
import { z } from "zod";

export type RawResponseShape =
  | "strict_json"
  | "markdown_fenced_json"
  | "prose_wrapped_json"
  | "malformed_json"
  | "refusal_text"
  | "empty";

export type CapturedCompletion = {
  provider: string;
  latencyMs: number;
  raw?: string;
  shape?: RawResponseShape;
  error?: string;
};

export type ReferenceSiteObservation = {
  siteId: string;
  kind: "cell" | "wifi";
  lat: number;
  lng: number;
  label: string | null;
};

const ModelDecision = z.strictObject({ decision: Decision });

/** E4's closed result parser. Extra confidence or reasoning fields are rejected. */
export function parseModelDecision(
  raw: string,
): { decision: z.infer<typeof Decision> } | { rejection: "schema_invalid" } {
  try {
    return ModelDecision.parse(extractJson(raw));
  } catch {
    return { rejection: "schema_invalid" };
  }
}

/**
 * Describe an event to the model without leaking any detector conclusion.
 *
 * Recipient and reference-site coordinates are independently stored context,
 * not engine output. Scores, rule ids, labels and the sealed decision are
 * deliberately absent: including them would measure paraphrasing, not whether
 * the model can make a judgement from the underlying observations.
 */
export function neutralEventEvidence(
  ctx: AgentContext,
  referenceSites: ReferenceSiteObservation[],
): string {
  const event = ctx.event;
  const signals = event ? vigilSignalsOf(event) : undefined;
  const sites = new Map(referenceSites.map((site) => [site.siteId, site]));
  const cellId = signals?.cell
    ? `${signals.cell.mcc}-${signals.cell.mnc}-${signals.cell.lac}-${signals.cell.cellId}`
    : undefined;

  return JSON.stringify(
    {
      event: event
        ? {
            type: event.type,
            eventTime: event.eventTime,
            serverReceiptTime: event.recordTime,
            bizStep: event.bizStep ?? null,
            disposition: event.disposition ?? null,
            courierClaim: event["vigil:courierId"] ?? null,
          }
        : null,
      parcel: {
        known: ctx.parcel?.known ?? false,
        recipientLocation: ctx.parcel?.recipientPoint ?? null,
        declaredValueSen: ctx.parcel?.declaredValueSen ?? null,
      },
      observations: {
        gps: signals?.gps ?? null,
        cell: cellId
          ? {
              observedId: cellId,
              signalDbm: signals?.cell?.signalDbm ?? null,
              registry: sites.get(cellId) ?? null,
            }
          : null,
        wifi:
          signals?.wifi?.map((observed) => ({
            ...observed,
            registry: sites.get(observed.bssid) ?? null,
          })) ?? [],
        motion: signals?.motion ?? null,
        deviceIntegrity: signals?.integrity ?? null,
        battery: signals?.battery ?? null,
        proofOfDelivery: signals?.pod ?? null,
      },
    },
    null,
    2,
  );
}

/** Describe transport form before the ordinary schema parser normalises it. */
export function classifyRawResponse(raw: string): RawResponseShape {
  const trimmed = raw.trim();
  if (trimmed === "") return "empty";

  if (/^```(?:json)?\s*[\s\S]*```$/i.test(trimmed)) {
    return "markdown_fenced_json";
  }

  try {
    JSON.parse(trimmed);
    return "strict_json";
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        JSON.parse(trimmed.slice(start, end + 1));
        return "prose_wrapped_json";
      } catch {
        return "malformed_json";
      }
    }
  }

  return /\b(?:cannot|can't|unable|refus|sorry)\b/i.test(trimmed)
    ? "refusal_text"
    : "malformed_json";
}

/** Make one provider call and retain enough metadata to replay or audit it. */
export async function captureCompletion(
  provider: LlmProvider,
  request: LlmRequest,
): Promise<CapturedCompletion> {
  const started = performance.now();
  try {
    const raw = await provider.complete(request);
    return {
      provider: provider.name,
      latencyMs: Math.round(performance.now() - started),
      raw,
      shape: classifyRawResponse(raw),
    };
  } catch (error) {
    return {
      provider: provider.name,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Replay exactly one captured success or failure without another model call. */
export function replayCaptured(captured: CapturedCompletion): LlmProvider {
  return {
    name: `${captured.provider}:replay`,
    complete: async () => {
      if (captured.error !== undefined) throw new Error(captured.error);
      return captured.raw ?? "";
    },
  };
}

export type AgreementStats = {
  attempts: number;
  histogram: Record<string, number>;
  distinct: number;
  top1: string;
  top1Share: number;
  top2Share: number;
  pairwiseDisagreement: number;
};

/** Agreement measures fixed before E4 observes a live answer. */
export function agreementStats(answers: string[]): AgreementStats {
  const histogram: Record<string, number> = {};
  for (const answer of answers) histogram[answer] = (histogram[answer] ?? 0) + 1;

  const ranked = Object.entries(histogram).sort(
    ([a, aCount], [b, bCount]) => bCount - aCount || a.localeCompare(b),
  );
  const attempts = answers.length;
  const samePairs = ranked.reduce((sum, [, count]) => sum + (count * (count - 1)) / 2, 0);
  const allPairs = (attempts * (attempts - 1)) / 2;

  return {
    attempts,
    histogram,
    distinct: ranked.length,
    top1: ranked[0]?.[0] ?? "",
    top1Share: attempts === 0 ? 0 : (ranked[0]?.[1] ?? 0) / attempts,
    top2Share:
      attempts === 0 ? 0 : ranked.slice(0, 2).reduce((sum, [, count]) => sum + count, 0) / attempts,
    pairwiseDisagreement: allPairs === 0 ? 0 : (allPairs - samePairs) / allPairs,
  };
}

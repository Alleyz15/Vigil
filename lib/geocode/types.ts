import { z } from "zod";

/**
 * Phase two's geocoding contract: a person's address text in, candidates out.
 *
 * THE DATA BOUNDARY IS THE TYPE. A search sends one thing to Nominatim — the
 * address text somebody typed into the search box — and a reverse lookup sends
 * one coordinate the person clicked. There is no field here for a name, a phone
 * number, a shipment or a courier, so there is nothing to leak by accident: a
 * caller cannot pass what the query type does not hold.
 *
 * NOTHING HERE IS A VERDICT INPUT. A resolved label is a description a person
 * reads beside a coordinate they still confirm themselves. It never reaches the
 * engine, the parcel's recipient address, or the explanation node (rule 1e —
 * provider text is untrusted input, and `lib/llm/prompts.test.ts` asserts it
 * is absent from the explain prompt).
 */

/** A search query, as typed. Normalised before it is keyed, sent or cached. */
export const SearchQuery = z.strictObject({
  q: z.string().trim().min(3).max(200),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

/** A clicked coordinate, already rounded to the picker's six decimals. */
export const ReverseQuery = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type ReverseQuery = z.infer<typeof ReverseQuery>;

/**
 * One place Nominatim returned.
 *
 * `latitude`/`longitude` are rounded ONCE, here, to the picker's six decimals —
 * the same rule as a map click, so the number a person sees beside a candidate
 * is the number that would be stored if they confirm it. `label` is the
 * provider's `display_name` with control characters removed and its length
 * capped: shown to a person, never interpreted.
 */
export const Candidate = z.strictObject({
  ref: z.string().regex(/^(node|way|relation)\/\d+$/),
  label: z.string().min(1).max(300),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type Candidate = z.infer<typeof Candidate>;

/**
 * Why a lookup produced no candidates. SIX DISTINCT REASONS, never collapsed
 * into "failed" (rule 4f): each tells the person something different to do.
 *
 *   unreachable   the request never got an answer — network, DNS, 5xx
 *   timeout       it was sent and nothing came back in time
 *   rate_limited  Nominatim said slow down (429), or Vigil's own queue is full
 *   refused       Nominatim answered with a refusal (403 or another 4xx)
 *   no_results    it answered, and there is nothing at that text or point
 *   malformed     it answered with something that is not the documented shape
 *
 * `no_results` is an ANSWER, not an error — it is cached like one.
 */
export type FailureReason = "unreachable" | "timeout" | "rate_limited" | "refused" | "no_results" | "malformed";

/** Where an answer came from. `demo` is the committed pre-warmed set. */
export type AnswerSource = "demo_cache" | "cache" | "network";

/** A lookup that produced nothing usable. `source` says whether that came from a cache or no answer at all. */
export type Failed = { status: "failed"; source: AnswerSource | "none"; reason: FailureReason; detail: string };

export type SearchResult = { status: "found"; source: AnswerSource; candidates: Candidate[] } | Failed;

/**
 * A reverse answer carries a LABEL and a reference, and NO COORDINATE OF ITS OWN.
 *
 * Nominatim answers a reverse query with the nearest object it knows, and that
 * object's position is not the clicked one. Returning it would put a second,
 * slightly different coordinate one assignment away from the pin. So the type
 * has nowhere to put it: the only coordinate in a reverse result is the query
 * the person clicked, handed back unchanged.
 */
export const ReverseLabel = z.strictObject({
  ref: Candidate.shape.ref,
  label: Candidate.shape.label,
});
export type ReverseLabel = z.infer<typeof ReverseLabel>;

export type ReverseResult = { status: "found"; source: AnswerSource; at: ReverseQuery; found: ReverseLabel } | Failed;

/**
 * A cache entry. The `query` is stored beside the answer and compared on read,
 * so a filename collision cannot hand one query another's answer (the weather
 * cache's rule). A cached `no_results` is an entry with an empty list.
 */
export const GeocodeCacheEntry = z.discriminatedUnion("kind", [
  z.strictObject({
    v: z.literal(1),
    provider: z.literal("nominatim"),
    kind: z.literal("search"),
    query: z.strictObject({ q: z.string() }),
    fetchedAt: z.iso.datetime({ offset: true }),
    candidates: z.array(Candidate),
  }),
  z.strictObject({
    v: z.literal(1),
    provider: z.literal("nominatim"),
    kind: z.literal("reverse"),
    query: ReverseQuery,
    fetchedAt: z.iso.datetime({ offset: true }),
    found: ReverseLabel.nullable(),
  }),
]);
export type GeocodeCacheEntry = z.infer<typeof GeocodeCacheEntry>;

export type Geocoder = {
  search(query: SearchQuery): Promise<SearchResult>;
  reverse(query: ReverseQuery): Promise<ReverseResult>;
};

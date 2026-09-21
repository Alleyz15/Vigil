import { z } from "zod";
import { Candidate, type Geocoder } from "./types";

/**
 * How a resolved label reaches the store: BY REFERENCE, NEVER AS TEXT.
 *
 * The browser does not send the label it displayed. It sends which lookup the
 * label came from — a search query and the chosen candidate's ref, or "reverse
 * at this point" — and the server reads the answer back out of the cache with
 * the network forbidden. So a label can only be stored if the geocoder actually
 * returned it for that point; a client cannot type one in and have it recorded
 * as resolved. Rule 3g: text that restates a decision is derived from the
 * decider, not supplied downstream.
 *
 * For a search pick there is a second check: the confirmed coordinate must be
 * the candidate's coordinate EXACTLY. A label is only a description of the
 * point it was found at; attached to a moved point it describes somewhere else.
 */
export const Resolution = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("search"), query: z.string().trim().min(3).max(200), ref: Candidate.shape.ref }),
  z.strictObject({ kind: z.literal("reverse") }),
]);
export type Resolution = z.infer<typeof Resolution>;

/** What is stored beside a coordinate, and who produced it. */
export type ResolvedLabel = { label: string; by: "search" | "reverse"; ref: string };

export type AttachResult = { ok: true; resolved: ResolvedLabel } | { ok: false; reason: string };

export async function verifyResolution(
  point: { latitude: number; longitude: number },
  resolution: Resolution,
  cached: Geocoder,
): Promise<AttachResult> {
  // Only the coordinate goes to the geocoder. Callers hand over the whole
  // confirmed point — claim, resolution and all — and the query is built from
  // two numbers rather than trusting that nothing else rides along.
  const at = { latitude: point.latitude, longitude: point.longitude };
  if (resolution.kind === "reverse") {
    const answer = await cached.reverse(at);
    if (answer.status !== "found") {
      return { ok: false, reason: "No address lookup for this exact point is on file, so no resolved address is stored." };
    }
    return { ok: true, resolved: { label: answer.found.label, by: "reverse", ref: answer.found.ref } };
  }

  const answer = await cached.search({ q: resolution.query });
  if (answer.status !== "found") {
    return { ok: false, reason: "That search is not on file, so the address it found cannot be stored." };
  }
  const candidate = answer.candidates.find((c) => c.ref === resolution.ref);
  if (!candidate) return { ok: false, reason: "That search did not return the chosen place." };
  if (candidate.latitude !== at.latitude || candidate.longitude !== at.longitude) {
    return {
      ok: false,
      reason: "The confirmed coordinate is not the chosen place's coordinate, so its address would describe somewhere else.",
    };
  }
  return { ok: true, resolved: { label: candidate.label, by: "search", ref: candidate.ref } };
}

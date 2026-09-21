"use client";

import { useState } from "react";
import { MapPinned, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GEOCODE_ATTRIBUTION, looksLikePhoneNumber, PHONE_REFUSAL } from "@/lib/geocode/messages";
import { formatCoordinate } from "@/lib/shipment/picker";

/**
 * ADDRESS SEARCH, BY BUTTON — NEVER AS YOU TYPE.
 *
 * Nominatim's usage policy forbids autocomplete, so this is a policy decision
 * rather than a design one: typing changes local state and nothing else, and a
 * request exists only when the person presses Search (or Enter, which submits
 * the same form). `address-search.test.ts` types into the box and counts the
 * requests.
 *
 * A RESULT IS NEVER ADOPTED BY ITSELF. The first match of a fuzzy search is a
 * guess about what somebody meant, so every candidate waits for a person to
 * choose it — and even then it only becomes the PENDING point, which still has
 * to be confirmed into a slot exactly like a map click.
 *
 * A candidate outside the service area is shown with the reason and the four
 * covered units, and has no "use" button at all — not a disabled one. The
 * check was made server-side against the same boundary the create route uses.
 */

export type SearchCandidate = {
  ref: string;
  label: string;
  latitude: number;
  longitude: number;
} & ({ selectable: true } | { selectable: false; refusal: string });

type Answer =
  | { kind: "found"; query: string; candidates: SearchCandidate[]; attribution: string }
  | { kind: "failed"; reason: string; message: string; attribution?: string }
  | { kind: "local"; message: string };

export function AddressSearch({
  onChoose,
}: {
  onChoose: (candidate: SearchCandidate & { selectable: true }, query: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const query = draft.trim();
    // Refused here, BEFORE a request exists: the data boundary is that only
    // address text is sent, and a person should see why theirs was not.
    if (query.length < 3) {
      setAnswer({ kind: "local", message: "Type at least three characters of an address." });
      return;
    }
    if (looksLikePhoneNumber(query)) {
      setAnswer({ kind: "local", message: PHONE_REFUSAL });
      return;
    }

    setBusy(true);
    setAnswer(null);
    try {
      const response = await fetch("/api/sender/geocode/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body) {
        setAnswer({ kind: "local", message: body?.error ?? "The search could not be sent to this server. Nothing was looked up." });
      } else if (body.status === "found") {
        setAnswer({ kind: "found", query: body.query, candidates: body.candidates, attribution: body.attribution });
      } else {
        setAnswer({ kind: "failed", reason: body.reason, message: body.message, attribution: body.attribution });
      }
    } catch {
      setAnswer({ kind: "local", message: "The search could not be sent to this server. Nothing was looked up." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <form onSubmit={submit} className="flex gap-2" role="search">
        <input
          aria-label="Search for an address"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={200}
          placeholder="Street, building or postcode"
          autoComplete="off"
          className="h-10 min-w-0 flex-1 rounded-md bg-muted/60 px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <Button type="submit" variant="secondary" disabled={busy}>
          <Search data-icon="inline-start" />
          {busy ? "Searching…" : "Search"}
        </Button>
      </form>
      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
        Only the text in this box is sent — never the recipient&apos;s name or number. Nothing is looked up
        until you press Search.
      </p>

      {answer?.kind === "found" && (
        <div className="mt-4">
          <ul className="divide-y rounded-md border" aria-label="Search results">
            {answer.candidates.map((candidate) => (
              <li key={candidate.ref} className="p-3">
                <p className="text-sm leading-6">{candidate.label}</p>
                <p className="font-mono text-xs tabular-nums text-muted-foreground">
                  {formatCoordinate(candidate.latitude)}, {formatCoordinate(candidate.longitude)}
                </p>
                {candidate.selectable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => onChoose(candidate, answer.query)}
                  >
                    <MapPinned data-icon="inline-start" />
                    Use this place
                  </Button>
                ) : (
                  <p className="mt-2 text-xs leading-5 text-amber-800 dark:text-amber-300">{candidate.refusal}</p>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {answer.attribution}. Choosing a place puts it on the map as the pending point; it is not used
            until you confirm it.
          </p>
        </div>
      )}

      {(answer?.kind === "failed" || answer?.kind === "local") && (
        <div className="mt-4">
          <p role="alert" data-reason={answer.kind === "failed" ? answer.reason : "local"} className="text-sm leading-6 text-amber-800 dark:text-amber-300">
            {answer.message}
          </p>
          {answer.kind === "failed" && (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{answer.attribution ?? GEOCODE_ATTRIBUTION}</p>
          )}
        </div>
      )}
    </div>
  );
}

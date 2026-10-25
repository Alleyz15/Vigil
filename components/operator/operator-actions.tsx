"use client";

import { useId, useRef, useState } from "react";
import { Check, FileQuestion, Route, Send, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HandoffDetail, HandoffState } from "@/lib/workbench";
import type { OperatorActionName } from "@/lib/workbench/types";
import { operatorActionAvailability, resolvedActionMessage } from "./handoff-detail-model";

export function OperatorActions({
  eventId,
  state,
  rerouteAvailable,
  rerouteReason,
  sealed,
  canApprove,
  approvalAuditPending,
  onDetailChange,
}: {
  eventId: string;
  state: HandoffState;
  rerouteAvailable: boolean;
  rerouteReason: string;
  sealed: boolean;
  canApprove?: boolean;
  approvalAuditPending?: boolean;
  onDetailChange: (detail: HandoffDetail) => void;
}) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const noteId = useId();
  const [requestOpen, setRequestOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const availability = operatorActionAvailability({ state, rerouteAvailable, canApprove, sealed, approvalAuditPending });
  const resolved = state.startsWith("resolved_") || state === "accepted";

  const act = async (action: OperatorActionName) => {
    if (inFlight.current || !availability[action] || (action === "request_evidence" && !note.trim())) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/operator/handoffs/${encodeURIComponent(eventId)}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "request_evidence" ? { action, note: note.trim() } : { action }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (body?.code === "CASE_ALREADY_RESOLVED" && body.detail) {
          onDetailChange(body.detail as HandoffDetail);
          setRequestOpen(false);
          return;
        }
        setError(body?.error ?? "The action could not be recorded.");
        return;
      }
      if (!body) throw new Error("Missing action response");
      onDetailChange(body as HandoffDetail);
      setRequestOpen(false);
      setNote("");
    } catch {
      setError("The action could not be recorded. Check the connection and retry.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  if (resolved) {
    return <p className="text-xs leading-5 text-muted-foreground">{resolvedActionMessage(sealed)}</p>;
  }

  return (
    <div>
      {availability.approve && (
        <Button className="w-full" size="lg" disabled={pending} onClick={() => act("approve")}>
          <Check data-icon="inline-start" />
          {approvalAuditPending ? "Retry approval audit" : "Approve and co-sign"}
        </Button>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button variant="outline" disabled={pending || !availability.request_evidence} aria-expanded={requestOpen} onClick={() => setRequestOpen(true)}>
          <FileQuestion data-icon="inline-start" />
          Request evidence
        </Button>
        <Button
          variant="outline"
          disabled={pending || !availability.propose_reroute}
          title={rerouteAvailable ? "Propose the authorised reroute" : rerouteReason}
          onClick={() => act("propose_reroute")}
        >
          <Route data-icon="inline-start" />
          Propose reroute
        </Button>
        <Button variant="outline" disabled={pending || !availability.escalate} onClick={() => act("escalate")}>
          <ShieldAlert data-icon="inline-start" />
          Escalate
        </Button>
        {/*
          REJECT IS QUIET, AND THAT IS DELIBERATE.

          A filled red button is the loudest thing in the panel, so the most
          destructive disposition was drawing the eye first and reading as the
          expected answer. Visual weight should follow what the operator is
          being invited to do, not how severe the action is — an operator who
          reaches for reject because it was the brightest control has been
          nudged by the layout rather than by the evidence.

          The colour stays only on the text, so it still reads as the
          destructive one at the moment of choosing.
        */}
        <Button
          variant="ghost"
          disabled={pending || !availability.reject}
          onClick={() => act("reject")}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <X data-icon="inline-start" />
          Reject
        </Button>
      </div>

      {requestOpen && availability.request_evidence && (
        <form className="mt-3 border-t pt-3" onSubmit={(event) => { event.preventDefault(); void act("request_evidence"); }}>
          <label htmlFor={noteId} className="text-xs font-semibold">Evidence request note</label>
          <textarea
            id={noteId}
            required
            autoFocus
            rows={3}
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
            className="mt-2 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="submit" disabled={pending || !note.trim()}><Send data-icon="inline-start" />Send request</Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => { setRequestOpen(false); setError(null); }}><X data-icon="inline-start" />Cancel</Button>
          </div>
        </form>
      )}
      {state === "awaiting_evidence" && <p className="mt-3 text-xs leading-5 text-muted-foreground">Waiting for the courier response to the current evidence request.</p>}
      {!rerouteAvailable && <p className="mt-2 text-xs leading-4 text-muted-foreground">{rerouteReason}</p>}
      {error && <p role="alert" className="mt-3 text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
}

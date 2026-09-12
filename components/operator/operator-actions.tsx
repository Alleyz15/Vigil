"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, FileQuestion, Route, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HandoffState } from "@/lib/workbench";
import type { OperatorActionName } from "@/lib/workbench/types";

export function OperatorActions({
  eventId,
  state,
  rerouteAvailable,
  rerouteReason,
}: {
  eventId: string;
  state: HandoffState;
  rerouteAvailable: boolean;
  rerouteReason: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const resolved = state.startsWith("resolved_") || state === "accepted";

  const act = (action: OperatorActionName) => {
    setError(null);
    startTransition(async () => {
      const response = await fetch(`/api/operator/handoffs/${eventId}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error ?? "The action could not be recorded.");
        return;
      }
      router.refresh();
    });
  };

  if (resolved) {
    return <p className="text-xs leading-5 text-muted-foreground">This work item is resolved. Its sealed verdict remains unchanged.</p>;
  }

  return (
    <div>
      {state === "awaiting_cosignature" && (
        <Button className="w-full" size="lg" disabled={pending} onClick={() => act("approve")}>
          <Check data-icon="inline-start" />
          Approve and co-sign
        </Button>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button variant="outline" disabled={pending} onClick={() => act("request_evidence")}>
          <FileQuestion data-icon="inline-start" />
          Request evidence
        </Button>
        <Button
          variant="outline"
          disabled={pending || !rerouteAvailable}
          title={rerouteAvailable ? "Propose the authorised reroute" : rerouteReason}
          onClick={() => act("propose_reroute")}
        >
          <Route data-icon="inline-start" />
          Propose reroute
        </Button>
        <Button variant="outline" disabled={pending} onClick={() => act("escalate")}>
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
          disabled={pending}
          onClick={() => act("reject")}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <X data-icon="inline-start" />
          Reject
        </Button>
      </div>

      {!rerouteAvailable && <p className="mt-2 text-xs leading-4 text-muted-foreground">{rerouteReason}</p>}
      {error && <p role="alert" className="mt-3 text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
}

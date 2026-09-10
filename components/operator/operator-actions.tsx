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
        <Button variant="destructive" disabled={pending} onClick={() => act("reject")}>
          <X data-icon="inline-start" />
          Reject
        </Button>
      </div>

      {!rerouteAvailable && <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{rerouteReason}</p>}
      {error && <p role="alert" className="mt-3 text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
}

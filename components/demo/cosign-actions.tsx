"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CosignModel } from "@/lib/demo/cosign";

/**
 * The two buttons, each on its own side of the screen.
 *
 * THEY CALL THE REAL ENDPOINTS. `/api/courier/drafts/[id]/submit` and
 * `/api/operator/handoffs/[id]/actions` are the same routes the `/courier` and
 * `/operator` surfaces use, so this view drives the actual two-phase flow
 * rather than animating a picture of it. A demo control with its own private
 * path would be a second implementation of the thing it claims to demonstrate,
 * and the copy that drifts is always the one without the tests.
 *
 * There is deliberately NO reset. The workbench is process-long by design and
 * session 17B decided against a restart endpoint; replaying the demo means
 * restarting the server, which the page says plainly rather than offering a
 * button that would quietly rewrite sealed history.
 */
export function CosignActions({
  model,
  side,
}: {
  model: CosignModel;
  side: "courier" | "operator";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const post = (url: string, body: unknown) => {
    setError(null);
    startTransition(async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        setError(detail?.error ?? "That did not go through.");
        return;
      }
      router.refresh();
    });
  };

  if (side === "courier") {
    if (model.phase !== "unsubmitted") {
      return (
        <p className="text-xs leading-5 text-muted-foreground">
          Submitted. The courier cannot do anything further — completing the credential is not
          theirs to do.
        </p>
      );
    }
    return (
      <div>
        <Button
          className="w-full"
          size="lg"
          disabled={pending}
          onClick={() =>
            post(`/api/courier/drafts/${model.courier.draftId}/submit`, { signed: true })
          }
        >
          <PenLine data-icon="inline-start" />
          Sign and submit
        </Button>
        {error && (
          <p role="alert" className="mt-2 text-xs leading-5 text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (model.phase === "sealed") {
    return (
      <p className="max-w-prose text-sm leading-6 text-muted-foreground">
        Co-signed. The identical event ran through the identical pipeline a second time with the
        completed credential — this was a second verification run, not a state toggle, and the
        first run&apos;s record is untouched. Restart the server to replay the flow.
      </p>
    );
  }

  if (!model.operator.canCosign) {
    return (
      <p className="max-w-prose text-sm leading-6 text-muted-foreground">
        No co-signature is being asked for in this state.
      </p>
    );
  }

  return (
    <div>
      <Button
        size="lg"
        disabled={pending}
        onClick={() =>
          post(`/api/operator/handoffs/${model.shared.eventId}/actions`, { action: "approve" })
        }
      >
        <Check data-icon="inline-start" />
        Approve and co-sign
      </Button>
      <p className="mt-2 max-w-prose text-xs leading-5 text-muted-foreground">
        This adds the operator&apos;s Ed25519 signature to the sidecar credential and re-runs the
        byte-identical event. It does not edit the verdict.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs leading-5 text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

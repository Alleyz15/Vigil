"use client";

import { useState } from "react";
import { CheckCircle2, CircleAlert, PackageCheck } from "lucide-react";
import { tokenMessage, type RecipientAnswer, type TokenState } from "@/lib/recipient/token";
import { Button } from "@/components/ui/button";

/**
 * One question, three outcomes, no account.
 *
 * A real recipient will not install an app or create a login to answer one
 * question, and demanding either would mean collecting no answers — which puts
 * P2, the strongest signal in the system, back to having no real input. The
 * link IS the authorisation: one parcel, one answer, an expiry.
 *
 * Nothing on this screen shows the recipient a score, a courier's name, a
 * verdict or anyone else's parcel. The capability is scoped and so is the view.
 */
export function ConfirmView({
  token,
  initial,
  waybillNo,
}: {
  token: string;
  initial: TokenState;
  waybillNo: string | null;
}) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(choice: RecipientAnswer) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/recipient/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: choice }),
      });
      const payload = await response.json();
      // A refusal still carries the authoritative state, so the screen tells the
      // truth about why rather than showing a generic failure.
      if (payload.state) setState(payload.state as TokenState);
      if (!response.ok && !payload.state) throw new Error(payload.error ?? "could not record your answer");
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const message = tokenMessage(state);
  const Icon = state.status === "answered" ? CheckCircle2 : state.status === "open" ? PackageCheck : CircleAlert;

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-12">
      <div className="rounded-lg border bg-card p-7">
        <Icon
          aria-hidden="true"
          className={
            state.status === "answered"
              ? "size-8 text-emerald-600 dark:text-emerald-400"
              : state.status === "open"
                ? "size-8 text-primary"
                : "size-8 text-muted-foreground"
          }
        />

        <h1 className="mt-4 text-xl font-semibold leading-tight">{message.headline}</h1>
        {waybillNo && (
          <p className="mt-1.5 font-mono text-xs text-muted-foreground">Parcel {waybillNo}</p>
        )}
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{message.detail}</p>

        {state.status === "open" && (
          <div className="mt-6 flex flex-col gap-2.5">
            <Button size="lg" onClick={() => answer("received")} disabled={busy}>
              Yes, I received it
            </Button>
            <Button size="lg" variant="outline" onClick={() => answer("not_received")} disabled={busy}>
              No, it did not arrive
            </Button>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}

        <p className="mt-6 border-t pt-4 text-xs leading-5 text-muted-foreground">
          This link is about one parcel and works once. It is not an account, and answering it
          gives no access to anything else.
        </p>
      </div>
    </div>
  );
}

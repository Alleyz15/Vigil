"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, FlaskConical, PackagePlus, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProvenanceLabel } from "@/components/operator/provenance-label";
import { cn } from "@/lib/utils";
import type { BuiltFault } from "@/lib/generate/builder";
import { RegisteredAddressMap } from "./registered-address-map";

export type SenderAddress = { index: number; label: string; latitude?: number; longitude?: number };

export type SenderPolicy = {
  cosignOverSen: number | null;
  codCapSen: number;
  maxValueSen: number;
  courier: string;
};

const FAULTS: { value: BuiltFault; label: string; detail: string }[] = [
  { value: "none", label: "None", detail: "No injected fault. The verifier still checks the shipment." },
  { value: "gps_spoof", label: "GPS spoof", detail: "The delivery scan claims the doorstep from elsewhere." },
  { value: "clock_tamper", label: "Clock tamper", detail: "The handset claims the scan happened in the server's future." },
  { value: "out_of_scope", label: "Out of scope", detail: "A parcel the courier's mandate does not cover." },
  { value: "eventid_reuse", label: "Event ID reuse", detail: "The same event ID resubmitted with different content." },
  { value: "batch_scan", label: "Batch scanning", detail: "Batch scanning is a property of a set, not of one parcel: it needs multiple parcels addressed to one building. A single shipment cannot express it." },
];

function ringgit(sen: number): string {
  return `RM ${(sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function SenderForm({
  addresses,
  policy,
}: {
  addresses: SenderAddress[];
  policy: SenderPolicy;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [originIndex, setOriginIndex] = useState(addresses.find((a) => a.index === 0)?.index ?? addresses[0]?.index ?? 0);
  const [destinationIndex, setDestinationIndex] = useState(addresses.find((a) => a.index === 20)?.index ?? addresses[1]?.index ?? 0);
  const [valueRinggit, setValueRinggit] = useState("120.00");
  const [channel, setChannel] = useState("+60119990001");
  const [recipientName, setRecipientName] = useState("");
  const [fault, setFault] = useState<BuiltFault>("none");

  const declaredValueSen = Math.round((Number.parseFloat(valueRinggit) || 0) * 100);

  /**
   * THE THRESHOLD CROSSING, SHOWN AS IT HAPPENS.
   *
   * `policy.cosignOverSen` is read from the courier's mandate, not restated
   * here — the gate reads the same field, so this sentence cannot drift from
   * the rule it describes (rule 3g).
   *
   * Cause before effect is the point: the viewer sees that this declaration
   * WILL require an operator before they submit, so when the courier's
   * submission then fails to seal, it is the consequence of something they
   * typed rather than a surprise the demo sprang on them.
   */
  const crossesCosign =
    policy.cosignOverSen !== null && declaredValueSen > policy.cosignOverSen;
  const overCodCap = declaredValueSen > policy.codCapSen && declaredValueSen > 0;
  const overMaxValue = declaredValueSen > policy.maxValueSen;

  const sameEnds = originIndex === destinationIndex;
  const batchRefused = fault === "batch_scan";
  const canSubmit = !pending && !sameEnds && !batchRefused && Number.isSafeInteger(declaredValueSen) && declaredValueSen > 0 && channel.length >= 3 && addresses.some((a) => a.index === originIndex) && addresses.some((a) => a.index === destinationIndex);

  const faultDetail = useMemo(
    () => FAULTS.find((f) => f.value === fault)?.detail ?? "",
    [fault],
  );

  const submit = () => {
    setError(null);
    startTransition(async () => {
      try {
      const response = await fetch("/api/sender/shipments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          originIndex,
          destinationIndex,
          declaredValueSen,
          recipientChannel: channel,
          recipientName: recipientName.trim() || undefined,
          fault,
        }),
      });

      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) {
        setError(body?.reason ?? body?.error ?? "That shipment could not be created.");
        return;
      }
      // Stays here: the parcel is out for delivery and the delivery scan is a
      // separate act. That gap is what makes a mid-route correction possible.
      router.refresh();
      } catch {
        setError("The request could not be confirmed. Reload before retrying; creation may have completed.");
      }
    });
  };

  return (
    <div id="create-shipment" className="scroll-mt-6">
      {/*
        The page's subject. At text-base it sat below the identity strip in
        weight, and the strip is background — who you are, not what you are here
        to do. Same size as the operator inbox's heading.
      */}
      <h1 className="text-2xl font-semibold">Create a shipment</h1>
      <p className="mt-1 max-w-prose text-sm leading-6 text-muted-foreground">
        Declare the delivery point, parcel value and recipient channel the courier will be checked against.
      </p>

      <div className="mt-4">
        <ProvenanceLabel>
          Addresses snap to {addresses.length} geocoded locations on file
        </ProvenanceLabel>
      </div>

      <div className="sender-workspace mt-6">
      <section className="min-w-0 rounded-lg border bg-card p-5">
      <h2 className="text-sm font-semibold">Shipment details</h2>
      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <Field label="Collect from">
          <Select value={originIndex} onChange={setOriginIndex} options={addresses} />
        </Field>
        <Field label="Deliver to">
          <Select value={destinationIndex} onChange={setDestinationIndex} options={addresses} />
        </Field>
      </div>

      {sameEnds && (
        <p className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-400">
          Collection and delivery are the same address. Choose two different ones.
        </p>
      )}

      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <Field label="Declared value">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">RM</span>
            <input
              aria-label="Declared value"
              inputMode="decimal"
              value={valueRinggit}
              onChange={(event) => setValueRinggit(event.target.value)}
              className="h-10 w-full rounded-md bg-muted/60 px-3 text-sm tabular-nums outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </Field>

        <Field label="Recipient's registered number">
          <input
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            className="h-10 w-full rounded-md bg-muted/60 px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
      </div>

      <Field label="Recipient name (optional)" className="mt-5">
        <input
          value={recipientName}
          onChange={(event) => setRecipientName(event.target.value)}
          placeholder="Left blank, a name is generated"
          className="h-10 w-full rounded-md bg-muted/60 px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </Field>

      {/* The consequence of the declaration, before it is submitted. */}
      <ValueConsequence
        policy={policy}
        declaredValueSen={declaredValueSen}
        crossesCosign={crossesCosign}
        overCodCap={overCodCap}
        overMaxValue={overMaxValue}
      />

      <FaultPanel
        fault={fault}
        onChange={setFault}
        detail={faultDetail}
        refused={batchRefused}
      />

      <div className="mt-7">
        <Button size="lg" disabled={!canSubmit} onClick={submit}>
          <PackagePlus data-icon="inline-start" />
          {pending ? "Dispatching…" : "Create and dispatch"}
        </Button>
        <p className="mt-2 max-w-prose text-xs leading-5 text-muted-foreground">
          Collection through to out-for-delivery runs immediately, through the same agent as a
          seeded scenario. The delivery scan waits below, so you can correct the address first.
        </p>
        {error && (
          <p role="alert" className="mt-3 max-w-prose text-sm leading-6 text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
      </section>
      <RegisteredAddressMap addresses={addresses} originIndex={originIndex} destinationIndex={destinationIndex} onOriginChange={setOriginIndex} onDestinationChange={setDestinationIndex} />
      </div>
    </div>
  );
}

/**
 * What this declaration will cause, stated before it is submitted.
 *
 * The co-signature figure comes from the mandate. A viewer who types 500 sees
 * that an operator will be required, then watches the courier's submission fail
 * to seal for exactly that reason — cause, then effect, both visible.
 */
function ValueConsequence({
  policy,
  declaredValueSen,
  crossesCosign,
  overCodCap,
  overMaxValue,
}: {
  policy: SenderPolicy;
  declaredValueSen: number;
  crossesCosign: boolean;
  overCodCap: boolean;
  overMaxValue: boolean;
}) {
  if (declaredValueSen <= 0) return null;

  return (
    <div
      className={cn(
        "mt-5 rounded-md px-4 py-3 text-sm leading-6",
        crossesCosign
          ? "bg-amber-500/10 text-amber-800 dark:text-amber-300"
          : "bg-muted/60 text-muted-foreground",
      )}
    >
      {crossesCosign ? (
        <>
          <span className="flex items-center gap-2 font-medium">
            <PenLine aria-hidden="true" className="size-4 shrink-0" />
            The amount condition requires an operator co-signature
          </span>
          <span className="mt-1 block">
            {ringgit(declaredValueSen)} is above {ringgit(policy.cosignOverSen ?? 0)}, the amount threshold provided by the current policy.
          </span>
        </>
      ) : (
        <span>
          {policy.cosignOverSen === null ? "No amount-based co-sign condition is listed in the policy." : `${ringgit(declaredValueSen)} is at or below ${ringgit(policy.cosignOverSen)}: the amount condition does not require co-signing.`}
        </span>
      )}

      <span className="mt-1 block text-xs">Other risk or evidence conditions may still require an operator signature.</span>
      {overMaxValue && (
        <span className="mt-2 flex items-center gap-2 font-medium">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          Above the mandate&apos;s {ringgit(policy.maxValueSen)} ceiling. The gate applies mandate limits independently of co-signing.
        </span>
      )}
      {overCodCap && !overMaxValue && (
        <span className="mt-2 block text-xs">
          Cash on delivery is capped at {ringgit(policy.codCapSen)}; this parcel is prepaid.
        </span>
      )}
    </div>
  );
}

/**
 * Fault injection, kept visibly apart from the form above it.
 *
 * CREATING A SHIPMENT IS PRODUCT BEHAVIOUR. INJECTING A GPS SPOOF IS NOT.
 * Blurring them would make the sender surface look like a place where fraud is
 * configured, which is both wrong and the third anti-reference in miniature.
 * The separation is structural — its own panel, its own provenance label — not
 * a note asking the viewer to remember.
 */
function FaultPanel({
  fault,
  onChange,
  detail,
  refused,
}: {
  fault: BuiltFault;
  onChange: (value: BuiltFault) => void;
  detail: string;
  refused: boolean;
}) {
  return (
    <section className="mt-8 rounded-lg bg-muted/40 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <FlaskConical aria-hidden="true" className="size-4" />
          Inject a fault
        </span>
        <ProvenanceLabel>Demo control · not product behaviour</ProvenanceLabel>
      </div>

      <p className="mt-2 max-w-prose text-xs leading-5 text-muted-foreground">
        Everything above is what a merchant would really declare. This is not: it bends one leg of
        the shipment so the detectors have something to find.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {FAULTS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              fault === option.value
                ? "bg-foreground font-medium text-background"
                : "bg-background hover:bg-muted",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <p
        className={cn(
          "mt-3 max-w-prose text-xs leading-5",
          refused ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
        )}
      >
        {detail}
      </p>
    </section>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <span className="mt-1.5 block">{children}</span>
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: number;
  onChange: (value: number) => void;
  options: SenderAddress[];
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className="h-10 w-full rounded-md bg-muted/60 px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
    >
      {options.map((option) => (
        <option key={option.index} value={option.index}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

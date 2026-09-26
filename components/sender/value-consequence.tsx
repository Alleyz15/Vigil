import { AlertTriangle, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";

export type SenderPolicy = {
  cosignOverSen: number | null;
  codCapSen: number;
  maxValueSen: number;
  courier: string;
};

function ringgit(sen: number): string {
  return `RM ${(sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The policy consequence of one declared value, shown before submission. */
export function ValueConsequence({
  policy,
  declaredValueSen,
}: {
  policy: SenderPolicy;
  declaredValueSen: number;
}) {
  if (declaredValueSen <= 0) return null;

  const crossesCosign = policy.cosignOverSen !== null && declaredValueSen > policy.cosignOverSen;
  const overCodCap = declaredValueSen > policy.codCapSen;
  const overMaxValue = declaredValueSen > policy.maxValueSen;

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
          {policy.cosignOverSen === null
            ? "No amount-based co-sign condition is listed in the policy."
            : `${ringgit(declaredValueSen)} is at or below ${ringgit(policy.cosignOverSen)}: the amount condition does not require co-signing.`}
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

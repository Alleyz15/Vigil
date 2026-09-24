import { Badge } from "@/components/ui/badge";
import type { HandoffState } from "@/lib/workbench";
import { cn } from "@/lib/utils";
import { ProvenanceLabel } from "./provenance-label";

const LABELS: Record<HandoffState, string> = {
  accepted: "Automatically accepted",
  flagged: "Flagged",
  awaiting_cosignature: "Awaiting co-signature",
  timed_out: "Timed out",
  awaiting_evidence: "Evidence requested",
  awaiting_reroute_signatures: "Reroute signatures pending",
  resolved_approved: "Approved and sealed",
  resolved_rejected: "Rejected by operator",
  resolved_escalated: "Escalated",
};

/**
 * The state, and — when the demo assigned it rather than the workbench working
 * it out — a label saying so, carried by the badge itself so every place that
 * shows the state shows the caveat (rule 1j).
 */
export function HandoffStateBadge({
  state,
  provenance = "computed",
  decision = null,
}: {
  state: HandoffState;
  provenance?: "computed" | "seeded";
  decision?: string | null;
}) {
  const label = state === "flagged" && decision !== "flag" ? "Needs review" : LABELS[state];
  const badge = (
    <Badge
      variant="outline"
      className={cn(
        "font-medium",
        state === "accepted" && "border-emerald-200 bg-emerald-50 text-emerald-800",
        state === "awaiting_cosignature" && "border-amber-200 bg-amber-50 text-amber-900",
        state === "timed_out" && "border-red-200 bg-red-50 text-red-800",
        state === "flagged" && "border-orange-200 bg-orange-50 text-orange-900",
      )}
    >
      {label}
    </Badge>
  );
  if (provenance === "computed") return badge;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      {badge}
      <ProvenanceLabel>Seeded state · no liveness timer</ProvenanceLabel>
    </span>
  );
}

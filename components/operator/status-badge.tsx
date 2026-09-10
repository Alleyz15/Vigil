import { Badge } from "@/components/ui/badge";
import type { HandoffState } from "@/lib/workbench";
import { cn } from "@/lib/utils";

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

export function HandoffStateBadge({ state }: { state: HandoffState }) {
  return (
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
      {LABELS[state]}
    </Badge>
  );
}

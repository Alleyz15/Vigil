"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * The four decisions, plus the two states that are NOT decisions.
 *
 * `halted` and `pending` are separate on purpose. A halted run sealed nothing,
 * and rendering it as a verdict would erase the difference between "this was
 * accepted" and "nothing was written". That distinction is the co-sign
 * primitive working, and it has to be legible without expanding the leg.
 */
export type VerdictKind = "accept" | "flag" | "escalate" | "freeze" | "pending" | "halted";

const STYLES: Record<VerdictKind, { label: string; className: string }> = {
  accept: { label: "accept", className: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" },
  flag: { label: "flag", className: "bg-amber-500/15 text-amber-300 ring-amber-500/30" },
  escalate: { label: "escalate", className: "bg-orange-500/15 text-orange-300 ring-orange-500/30" },
  freeze: { label: "freeze", className: "bg-rose-500/15 text-rose-300 ring-rose-500/30" },
  // Dashed, because nothing was sealed. It reads as an open state rather than
  // an outcome, which is exactly what it is.
  pending: {
    label: "awaiting co-signature",
    className: "bg-sky-500/10 text-sky-300 ring-sky-500/40 ring-dashed",
  },
  halted: { label: "halted — nothing sealed", className: "bg-zinc-500/10 text-zinc-300 ring-zinc-500/30" },
};

export function VerdictBadge({ kind, className }: { kind: VerdictKind; className?: string }) {
  const style = STYLES[kind];

  return (
    <motion.span
      // Keyed on the kind so a change animates; this is one of the three places
      // motion is allowed. Radix is never wrapped in AnimatePresence.
      key={kind}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap",
        style.className,
        className,
      )}
    >
      {style.label}
    </motion.span>
  );
}

/** What a leg should show, given that a halt is not a decision. */
export function verdictKindFor(leg: {
  decision: string | null;
  halted: { reason: string } | null;
}): VerdictKind {
  if (leg.halted?.reason === "PENDING_COSIGNATURE") return "pending";
  if (leg.decision === null) return "halted";
  return leg.decision as VerdictKind;
}

const HANDOFF_DESCRIPTION =
  "Inbox and all handoffs share one table. The URL selects the working mode.";

const EVIDENCE_DESCRIPTION = "Inspect the deterministic evidence behind operator decisions.";

export function getOperatorShellCopy(pathname: string): {
  title: string;
  description: string;
} {
  if (pathname.startsWith("/operator/inbox") || pathname.startsWith("/operator/handoffs")) {
    return {
      title: "Operator handoffs",
      description: HANDOFF_DESCRIPTION,
    };
  }

  if (pathname.startsWith("/demo/gate") || pathname === "/gate") {
    return {
      title: "Gate evidence",
      description:
        "Orthogonal gate evidence: two axes, never summed, with unevaluated points outside the numeric scale.",
    };
  }

  if (pathname === "/verify") {
    return {
      title: "Verify ledger",
      description:
        "Recompute the audit trail in-browser from raw JSONL. The server does not return a verdict.",
    };
  }

  if (pathname.startsWith("/demo/models")) {
    return {
      title: "Model divergence",
      description:
        "Measured E4a evidence: model families can be stable within themselves and still disagree with each other.",
    };
  }

  return {
    title: "Operator evidence",
    description: EVIDENCE_DESCRIPTION,
  };
}

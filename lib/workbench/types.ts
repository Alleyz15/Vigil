import { z } from "zod";

export const CaseState = z.enum([
  "flagged",
  "awaiting_cosignature",
  "timed_out",
  "awaiting_evidence",
  "awaiting_reroute_signatures",
  "resolved_approved",
  "resolved_rejected",
  "resolved_escalated",
]);
export type CaseState = z.infer<typeof CaseState>;

export const OperatorActionName = z.enum([
  "approve",
  "reject",
  "request_evidence",
  "propose_reroute",
  "escalate",
]);
export type OperatorActionName = z.infer<typeof OperatorActionName>;

export const OperatorActionRequest = z.strictObject({
  action: OperatorActionName,
  note: z.string().trim().max(500).optional(),
});
export type OperatorActionRequest = z.infer<typeof OperatorActionRequest>;


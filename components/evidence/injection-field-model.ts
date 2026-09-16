import type { InjectionReport, InjectionRow } from "@/lib/evidence/e4";

export function filterInjectionFields(report: InjectionReport, surface: string | null) {
  const payloads = report.payloads.filter(payload => surface === null || payload.surface === surface);
  const ids = new Set(payloads.map(payload => payload.payloadId));
  return { payloads, rows: report.rows.filter(row => ids.has(row.payloadId)) };
}

export function injectionMovementLabel(row: InjectionRow): string {
  if (row.cleanDecision !== "accept" && row.injectedDecision === "accept") return "Reached accept";
  return row.changed ? "Changed" : "Unchanged";
}

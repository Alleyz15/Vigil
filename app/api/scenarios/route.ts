import { NextResponse } from "next/server";
import { loadAllScenarios } from "@/lib/console/dataset";

/**
 * Every scenario, without its legs.
 *
 * Read-only, like every route here. Nothing in the console recomputes a
 * verdict; these read what the agent already sealed.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const scenarios = await loadAllScenarios();

  return NextResponse.json({
    scenarios: scenarios.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      courierId: s.courierId,
      legCount: s.legCount,
      exceptionLegIndex: s.exceptionLegIndex,
      expectedDecision: s.expectedDecision,
      ledger: s.ledger,
    })),
  });
}

import { NextResponse } from "next/server";
import { SCENARIO_IDS, type ScenarioId, loadScenario } from "@/lib/console/dataset";

/** One shipment's legs and their sealed verdicts. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("scenario") as ScenarioId | null;

  if (!id || !SCENARIO_IDS.includes(id)) {
    return NextResponse.json(
      { error: `unknown scenario; expected one of ${SCENARIO_IDS.join(", ")}` },
      { status: 400 },
    );
  }

  const { view } = await loadScenario(id);
  return NextResponse.json(view);
}

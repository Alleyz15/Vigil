import { NextResponse } from "next/server";
import { loadScatter } from "@/lib/console/dataset";

/**
 * Every event across every scenario, for the gate explorer.
 *
 * A null score means the axis could NOT BE EVALUATED, and the matching reason
 * says why. It does not mean zero, and the client must not plot it as one —
 * see CLAUDE.md on not asserting precision the data does not have.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const points = await loadScatter();

  return NextResponse.json({
    points,
    counts: {
      total: points.length,
      bothEvaluated: points.filter((p) => p.inconsistencyScore !== null && p.patternScore !== null).length,
      patternUnknown: points.filter((p) => p.patternScore === null).length,
      inconsistencyUnknown: points.filter((p) => p.inconsistencyScore === null).length,
    },
  });
}

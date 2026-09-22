import { NextResponse } from "next/server";
import { resolveRuntimeLlm } from "@/lib/llm/runtime";

export const dynamic = "force-dynamic";

export function GET() {
  const runtime = resolveRuntimeLlm();
  return NextResponse.json({
    selection: runtime.selection,
    modelId: runtime.modelId,
    keyPresent: runtime.keyPresent,
    available: runtime.provider !== null,
    reason: runtime.reason,
  });
}

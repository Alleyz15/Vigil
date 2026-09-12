import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

/**
 * What a sender may declare, and nothing else.
 *
 * `strictObject` for the same reason the courier's submission endpoint uses
 * one: there is deliberately no field here for a decision, a risk level or a
 * verdict. A sender declares; everything after that is computed. Accepting more
 * would be the start of a client that can influence an outcome.
 *
 * The fault is the exception, and it is honest about being one — it is a demo
 * control, labelled as such on the surface that sends it.
 */
const Declaration = z.strictObject({
  originIndex: z.number().int().min(0),
  destinationIndex: z.number().int().min(0),
  declaredValueSen: z.number().int().positive(),
  recipientChannel: z.string().min(3),
  recipientName: z.string().min(1).optional(),
  fault: z.enum(["none", "gps_spoof", "clock_tamper", "out_of_scope", "eventid_reuse", "batch_scan"]),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = Declaration.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid declaration", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const workbench = await getWorkbench();
  const result = await workbench.runBuilt(parsed.data);

  // A refusal is a 200 carrying a reason, not a server error: the request was
  // well formed and the answer is "this fault cannot apply to this route".
  return NextResponse.json(result);
}

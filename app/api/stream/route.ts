import { rmSync } from "node:fs";
import { runAgent } from "@/lib/agent/machine";
import { toSseMessage } from "@/lib/agent/trace";
import {
  SCENARIO_IDS,
  buildScenario,
  buildWorld,
  createHarness,
  ingestWithApproval,
  makeRng,
  seedFleetBackground,
} from "@/lib/generate";
import { cosign, courierCredential } from "@/lib/credential";
import { epcsOf } from "@/lib/epcis";
import { closeDb } from "@/lib/db/client";
import type { ScenarioId } from "@/lib/generate/scenarios/types";
import { CONSOLE_SEED, CONSOLE_START_MS } from "@/lib/console/dataset";
import { openMeteoProvider } from "@/lib/weather";

/**
 * The reasoning stream.
 *
 * Runs ONE event through the real agent and streams the trace frames the run
 * actually emits. Nothing is replayed from a recording: the delays a viewer
 * sees between nodes are the nodes executing.
 *
 * NEEDS A PLAIN NODE SERVER. A serverless platform will cut this off at its
 * function timeout — Vercel's free tier is 10 seconds, and preparing S2 alone
 * takes longer than that. This is part of why the demo runs locally and is
 * recorded rather than deployed. See CLAUDE.md.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A frame the console shows that the agent does not emit: preparation progress. */
function progressFrame(message: string, detail: Record<string, unknown> = {}): string {
  return `event: preparing\ndata: ${JSON.stringify({ message, ...detail })}\n\n`;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = params.get("scenario") as ScenarioId | null;
  const legParam = Number(params.get("leg") ?? "NaN");

  if (!id || !SCENARIO_IDS.includes(id)) {
    return new Response(`unknown scenario; expected one of ${SCENARIO_IDS.join(", ")}`, {
      status: 400,
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));

      const world = buildWorld(CONSOLE_SEED);
      const scenario = buildScenario(id, {
        world,
        rng: makeRng(CONSOLE_SEED),
        startMs: CONSOLE_START_MS,
      });

      const targetLeg = Number.isFinite(legParam)
        ? Math.max(0, Math.min(legParam, scenario.timeline.length - 1))
        : scenario.timeline.length - 1;

      const harness = createHarness(world);
      harness.deps.weather = openMeteoProvider();

      try {
        const args = {
          courierPrivateKey: scenario.courier.keys.privateKey,
          mandateId: scenario.courier.mandate.mandateId,
        };

        // The preparation is real work, and saying what it is doing matters: a
        // viewer should understand the pipeline is running, not that the app is
        // slow. The courier's history has to exist before the pattern axis can
        // say anything about it.
        send(
          progressFrame(
            `Replaying ${scenario.warmup.length} prior handoffs to build this courier's history`,
            { phase: "warmup", total: scenario.warmup.length },
          ),
        );
        seedFleetBackground(harness, world, {
          excludeCourierId: scenario.courier.courierId,
          startMs: CONSOLE_START_MS - 8 * 3_600_000,
        });
        for (const built of scenario.warmup) {
          await ingestWithApproval(harness, built, args);
        }

        if (targetLeg > 0) {
          send(
            progressFrame(`Replaying legs 1-${targetLeg} of this shipment`, {
              phase: "legs",
              total: targetLeg,
            }),
          );
          for (const built of scenario.timeline.slice(0, targetLeg)) {
            await ingestWithApproval(harness, built, args);
          }
        }

        const built = scenario.timeline[targetLeg];
        send(
          progressFrame(`Running leg ${targetLeg + 1} through the agent`, {
            phase: "target",
            leg: targetLeg,
            bizStep: built.event.bizStep ?? null,
          }),
        );

        // A co-signature is attached up front here rather than running the
        // two-phase flow, so the stream shows one complete pass through the
        // eight nodes. The pending path has its own demonstration on the
        // timeline view.
        const subject = {
          v: 1 as const,
          eventID: built.event.eventID,
          epc: epcsOf(built.event)[0] ?? "",
          courierId: built.event["vigil:courierId"] ?? "",
          mandateId: args.mandateId,
          nonce: `nonce-${built.event.eventID}`,
        };
        const credential = cosign(
          courierCredential(subject, args.courierPrivateKey),
          "OP-01",
          harness.operator.privateKey,
        );

        await runAgent(
          built.event,
          {
            ...harness.deps,
            now: () => new Date(Date.parse(built.event.recordTime ?? built.event.eventTime)),
          },
          {
            credential,
            // Every frame goes out as the node that produced it finishes.
            onTrace: (frame) => send(toSseMessage(frame)),
          },
        );

        send(`event: complete\ndata: ${JSON.stringify({ leg: targetLeg })}\n\n`);
      } catch (err) {
        send(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
      } finally {
        closeDb(harness.deps.db);
        rmSync(harness.dir, { recursive: true, force: true });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Proxies that buffer will hold every frame until the run ends, which
      // destroys the point of streaming the reasoning at all.
      "X-Accel-Buffering": "no",
    },
  });
}

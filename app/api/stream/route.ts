import { toSseMessage } from "@/lib/agent/trace";
import { getWorkbench } from "@/lib/workbench";

/** Live reasoning replay over the same workbench preparation path as ingest. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function event(name: string, value: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const scenarioId = params.get("scenario") ?? "";
  const leg = Number(params.get("leg") ?? "NaN");
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      try {
        if (!scenarioId) throw new Error("No shipment reference was provided for replay.");
        if (!Number.isInteger(leg) || leg < 0) throw new Error("The replay leg must be a zero-based whole number.");

        await (await getWorkbench()).replayHandoff(scenarioId, leg, {
          onProgress: (message) => send(event("preparing", { message })),
          onTrace: (frame) => send(toSseMessage(frame)),
        });
        send(event("complete", { leg }));
      } catch (error) {
        // Native EventSource hides a 4xx body and retries transport failures.
        // A terminal application frame keeps the reason visible and retry explicit.
        send(event("failure", { message: error instanceof Error ? error.message : "Replay failed." }));
        send(event("complete", { leg, failed: true }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

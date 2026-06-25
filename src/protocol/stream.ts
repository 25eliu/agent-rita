import type { SSEEvent } from "./types";
import { getLogger } from "../lib/logger";

const logger = getLogger(["app", "sse"]);
const encoder = new TextEncoder();
const LIVE_DEBUG_TRACES_LEVEL = Number(process.env.LIVE_DEBUG_TRACES ?? 0);

function traceSseEvent(value: SSEEvent, finalText: { chunks: string[] }): void {
  if (LIVE_DEBUG_TRACES_LEVEL < 1) return;

  if (value.event === "copilotStatusUpdate") {
    const data = value.data as {
      eventType?: string;
      message?: string;
      group?: string;
      details?: unknown;
      artifacts?: unknown;
    };
    const expanded = data.artifacts ?? data.details;
    const suffix = expanded != null
      ? `\n${JSON.stringify(expanded, null, 2)}`
      : "";
    console.error(`[rita:${data.group ?? "status"}:${data.eventType ?? "INFO"}] ${data.message ?? ""}${suffix}`);
    return;
  }

  if (value.event === "copilotFunctionCall") {
    const data = value.data as {
      function?: string;
      input_arguments?: Record<string, unknown>;
    };
    console.error(
      `[rita:tool] ${data.function ?? "unknown"}\n` +
        JSON.stringify(data.input_arguments ?? {}, null, 2),
    );
    return;
  }

  if (value.event === "copilotMessageChunk") {
    const data = value.data as { delta?: unknown };
    if (typeof data.delta === "string") finalText.chunks.push(data.delta);
    return;
  }

  if (value.event === "copilotMessageArtifact") {
    const data = value.data as { type?: string; name?: string; uuid?: string };
    console.error(
      `[rita:artifact] ${data.type ?? "artifact"} ${data.name ?? ""} ${data.uuid ?? ""}`.trim(),
    );
    return;
  }

  if (value.event === "copilotCitationCollection") {
    const data = value.data as { citations?: unknown[] };
    console.error(`[rita:citations] ${data.citations?.length ?? 0}`);
  }
}

function flushTraceFinal(finalText: { chunks: string[] }): void {
  if (LIVE_DEBUG_TRACES_LEVEL < 1 || finalText.chunks.length === 0) return;
  const text = finalText.chunks.join("").trim();
  finalText.chunks = [];
  if (text) console.error(`[rita:final]\n${text}\n[/rita:final]`);
}

export function sseResponse(
  generator: AsyncGenerator<SSEEvent> | (() => AsyncGenerator<SSEEvent>),
): Response {
  const gen = typeof generator === "function" ? generator() : generator;

  let closed = false;
  const finalText = { chunks: [] as string[] };

  const readable = new ReadableStream({
    async pull(controller) {
      if (closed) return;
      try {
        const { value, done } = await gen.next();
        if (closed) return;
        if (done) {
          closed = true;
          flushTraceFinal(finalText);
          controller.close();
          return;
        }
        traceSseEvent(value, finalText);
        const line = `event: ${value.event}\ndata: ${JSON.stringify(value.data)}\n\n`;
        controller.enqueue(encoder.encode(line));
      } catch (e) {
        if (closed) return;
        closed = true;
        logger.error("Stream error", { error: e });
        const errMsg = e instanceof Error ? e.message : String(e);
        const errorEvent: SSEEvent = {
          event: "copilotStatusUpdate",
          data: { eventType: "ERROR", message: errMsg, group: "reasoning" },
        };
        const line = `event: ${errorEvent.event}\ndata: ${JSON.stringify(errorEvent.data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(line));
          controller.close();
        } catch {
          // Controller already closed (client disconnected)
        }
      }
    },
    cancel() {
      closed = true;
      flushTraceFinal(finalText);
      gen.return(undefined);
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

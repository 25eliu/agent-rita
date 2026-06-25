import { describe, it, expect } from "bun:test";
import { sseResponse } from "../../../../src/protocol/stream";
import type { SSEEvent } from "../../../../src/protocol/types";

async function* yieldEvents(events: SSEEvent[]): AsyncGenerator<SSEEvent> {
  for (const e of events) yield e;
}

async function readBody(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

describe("sseResponse — headers", () => {
  it("sets text/event-stream content type and no-cache", async () => {
    const res = sseResponse(yieldEvents([]));
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    await res.body!.cancel();
  });
});

describe("sseResponse — encoding", () => {
  it("emits one event line + JSON data line per event, blank line separator", async () => {
    const res = sseResponse(
      yieldEvents([
        { event: "copilotMessageChunk", data: { delta: "hi" } },
        { event: "copilotStatusUpdate", data: { eventType: "INFO", message: "step", group: "reasoning" } },
      ]),
    );
    const body = await readBody(res);
    const blocks = body.split("\n\n").filter(Boolean);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(`event: copilotMessageChunk\ndata: {"delta":"hi"}`);
    expect(blocks[1]).toBe(
      `event: copilotStatusUpdate\ndata: {"eventType":"INFO","message":"step","group":"reasoning"}`,
    );
  });

  it("accepts a thunk that returns the generator", async () => {
    const res = sseResponse(() => yieldEvents([{ event: "copilotMessageChunk", data: { delta: "x" } }]));
    expect(await readBody(res)).toContain('"delta":"x"');
  });

  it("returns no body content when the generator yields nothing", async () => {
    const res = sseResponse(yieldEvents([]));
    expect(await readBody(res)).toBe("");
  });
});

describe("sseResponse — error path", () => {
  it("emits a copilotStatusUpdate ERROR event when the generator throws", async () => {
    async function* throwing(): AsyncGenerator<SSEEvent> {
      yield { event: "copilotMessageChunk", data: { delta: "ok" } };
      throw new Error("upstream boom");
    }
    const res = sseResponse(throwing());
    const body = await readBody(res);
    expect(body).toContain('"delta":"ok"');
    expect(body).toContain('"eventType":"ERROR"');
    expect(body).toContain("upstream boom");
  });
});

describe("sseResponse — cancellation", () => {
  it("calls generator.return on stream cancel", async () => {
    let returned = false;
    async function* gen(): AsyncGenerator<SSEEvent> {
      try {
        yield { event: "copilotMessageChunk", data: { delta: "first" } };
        yield { event: "copilotMessageChunk", data: { delta: "should-not-emit" } };
      } finally {
        returned = true;
      }
    }
    const res = sseResponse(gen());
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    // Yield a tick so the cancel callback runs the generator's finally.
    await new Promise((r) => setTimeout(r, 0));
    expect(returned).toBe(true);
  });
});

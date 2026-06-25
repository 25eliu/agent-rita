/**
 * Reads a Hono SSE Response body into a list of `{ event, data }` blocks.
 * Used by Tier 2 route integration tests; the loop tests drain the
 * AsyncGenerator directly via `for await` instead.
 */

export interface SseBlock {
  event: string;
  data: unknown;
}

export async function readSse(res: Response): Promise<SseBlock[]> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  buffer += decoder.decode();
  return parseSseBuffer(buffer);
}

function parseSseBuffer(buffer: string): SseBlock[] {
  const out: SseBlock[] = [];
  for (const block of buffer.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "";
    let dataLine = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) dataLine = line.slice(6);
    }
    let data: unknown = dataLine;
    try {
      data = JSON.parse(dataLine);
    } catch {
      // leave as raw string
    }
    out.push({ event, data });
  }
  return out;
}

export async function collectGenerator<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

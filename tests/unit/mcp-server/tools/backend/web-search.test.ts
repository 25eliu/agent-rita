import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { webSearchHandler } from "../../../../../mcp-server/src/tools/backend/web-search";

const realFetch = globalThis.fetch;
const realKey = process.env.TAVILY_API_KEY;

function mockFetch(impl: (input: { url: string; body: unknown }) => Response | Promise<Response>) {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return impl({ url, body });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = realFetch;
  process.env.TAVILY_API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = realKey;
});

describe("webSearchHandler — env guard", () => {
  it("returns a 'not configured' item when TAVILY_API_KEY is absent", async () => {
    delete process.env.TAVILY_API_KEY;
    const res = await webSearchHandler({ query: "anything" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toContain("not configured");
  });
});

describe("webSearchHandler — happy path", () => {
  it("emits a summary text + one citation per result", async () => {
    mockFetch(({ url, body }) => {
      expect(url).toBe("https://api.tavily.com/search");
      expect(body).toMatchObject({
        api_key: "test-key",
        query: "openbb",
        max_results: 3,
        search_depth: "basic",
      });
      return new Response(
        JSON.stringify({
          results: [
            { title: "Result 1", url: "https://r1", content: "snippet 1" },
            { title: "Result 2", url: "https://r2", content: "snippet 2" },
          ],
        }),
      );
    });
    const res = await webSearchHandler({ query: "openbb", max_results: 3 });
    expect(res.content).toHaveLength(3);
    expect(res.content[0].text).toContain("Result 1");
    expect(res.content[0].text).toContain("https://r1");
    expect(res.content[0].text).toContain("---");
    const c1 = JSON.parse(res.content[1].text);
    expect(c1.$rita_kind).toBe("citation");
    expect(c1.citation.url).toBe("https://r1");
    const c2 = JSON.parse(res.content[2].text);
    expect(c2.citation.url).toBe("https://r2");
  });

  it("defaults max_results to 5 when not supplied", async () => {
    mockFetch(({ body }) => {
      expect((body as { max_results: number }).max_results).toBe(5);
      return new Response(JSON.stringify({ results: [] }));
    });
    await webSearchHandler({ query: "x" });
  });

  it("returns a 'no results' item when API responds with empty list", async () => {
    mockFetch(() => new Response(JSON.stringify({ results: [] })));
    const res = await webSearchHandler({ query: "no-such-thing" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toContain("No results found");
  });
});

describe("webSearchHandler — failure paths", () => {
  it("surfaces non-2xx status + body in a single text item", async () => {
    mockFetch(() => new Response("rate limited", { status: 429 }));
    const res = await webSearchHandler({ query: "x" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toContain("Search failed (429)");
    expect(res.content[0].text).toContain("rate limited");
  });

  it("returns a timeout text item when AbortError is raised", async () => {
    globalThis.fetch = mock(() => {
      const err = new Error("aborted") as Error & { name: string };
      err.name = "AbortError";
      return Promise.reject(err);
    }) as unknown as typeof fetch;
    const res = await webSearchHandler({ query: "x" });
    expect(res.content[0].text).toContain("timed out");
  });

  it("rethrows non-abort errors so the MCP runtime can surface them", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    await expect(webSearchHandler({ query: "x" })).rejects.toThrow("boom");
  });
});

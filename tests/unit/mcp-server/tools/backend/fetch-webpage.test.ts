import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { fetchWebpageHandler } from "../../../../../mcp-server/src/tools/backend/fetch-webpage";

const realFetch = globalThis.fetch;

function mockFetch(impl: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = mock((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(impl(url));
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchWebpageHandler — happy path", () => {
  it("returns markdown text + a web citation when fetch succeeds", async () => {
    mockFetch(() =>
      new Response(
        "<html><head><title>Hello</title></head><body><h1>Heading</h1><p>Body</p><script>x()</script></body></html>",
        { status: 200 },
      ),
    );
    const res = await fetchWebpageHandler({ url: "https://example.com" });
    expect(res.content).toHaveLength(2);
    expect(res.content[0].text).toContain("Heading");
    expect(res.content[0].text).toContain("Body");
    expect(res.content[0].text).not.toContain("script");
    const cit = JSON.parse(res.content[1].text);
    expect(cit.$rita_kind).toBe("citation");
    expect(cit.citation.type).toBe("web");
    expect(cit.citation.url).toBe("https://example.com");
    expect(cit.citation.title).toBe("Hello");
  });

  it("decodes HTML entities in the title", async () => {
    mockFetch(() => new Response("<html><head><title>A &amp; B</title></head><body>x</body></html>"));
    const res = await fetchWebpageHandler({ url: "https://example.com" });
    const cit = JSON.parse(res.content[1].text);
    expect(cit.citation.title).toBe("A & B");
  });

  it("falls back title to hostname when none present", async () => {
    mockFetch(() => new Response("<html><body>plain</body></html>"));
    const res = await fetchWebpageHandler({ url: "https://example.com/page" });
    const cit = JSON.parse(res.content[1].text);
    expect(cit.citation.title).toBe("example.com");
  });

  it("truncates markdown output to 20k chars", async () => {
    const big = "<p>" + "a".repeat(30_000) + "</p>";
    mockFetch(() => new Response(`<html><body>${big}</body></html>`));
    const res = await fetchWebpageHandler({ url: "https://example.com" });
    expect(res.content[0].text.length).toBeLessThanOrEqual(20_000);
  });
});

describe("fetchWebpageHandler — failure paths", () => {
  it("returns an explanatory text item on non-2xx response", async () => {
    mockFetch(() => new Response("not found", { status: 404, statusText: "Not Found" }));
    const res = await fetchWebpageHandler({ url: "https://example.com" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toContain("Failed to fetch");
    expect(res.content[0].text).toContain("404");
  });

  it("returns an error item when fetch throws", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const res = await fetchWebpageHandler({ url: "https://example.com" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toContain("Failed to fetch");
    expect(res.content[0].text).toContain("offline");
  });
});

describe("fetchWebpageHandler — turndown isolation", () => {
  it("does not leak `.remove()` state across calls", async () => {
    // Call once with a script tag to verify it's stripped.
    mockFetch(() => new Response("<html><body><p>visible</p><script>secret</script></body></html>"));
    const a = await fetchWebpageHandler({ url: "https://x" });
    expect(a.content[0].text).not.toContain("secret");

    // Call again — state must remain fresh, scripts still stripped.
    const b = await fetchWebpageHandler({ url: "https://x" });
    expect(b.content[0].text).not.toContain("secret");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { prefetchUrls, urlCitationId } from "../../../../src/agent/url-prefetch";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string) => { status?: number; body?: string }): void {
  globalThis.fetch = (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body = "<html><head><title>OK</title></head><body><p>hi</p></body></html>" } =
      handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "ERR",
      text: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("prefetchUrls", () => {
  it("returns empty array for no urls", async () => {
    expect(await prefetchUrls(undefined)).toEqual([]);
    expect(await prefetchUrls([])).toEqual([]);
  });

  it("fetches each URL and extracts title + markdown", async () => {
    mockFetch(() => ({
      body: "<html><head><title>Tesla Q4</title></head><body><h1>Revenue</h1><p>21.3B</p></body></html>",
    }));
    const out = await prefetchUrls(["https://x.com/a", "https://y.com/b"]);
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe("Tesla Q4");
    expect(out[0].markdown).toContain("Revenue");
    expect(out[0].markdown).toContain("21.3B");
  });

  it("falls back to hostname when no title tag present", async () => {
    mockFetch(() => ({ body: "<html><body><p>no title</p></body></html>" }));
    const out = await prefetchUrls(["https://example.com/path"]);
    expect(out[0].title).toBe("example.com");
  });

  it("swallows individual failures and keeps successes", async () => {
    mockFetch((url) =>
      url.includes("bad")
        ? { status: 500 }
        : { body: "<html><title>OK</title><body>data</body></html>" },
    );
    const out = await prefetchUrls(["https://bad.com", "https://good.com"]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://good.com");
  });

  it("caps to 4 URLs", async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      return { body: "<html><title>X</title><body>X</body></html>" };
    });
    await prefetchUrls([
      "https://a.com",
      "https://b.com",
      "https://c.com",
      "https://d.com",
      "https://e.com",
      "https://f.com",
    ]);
    expect(calls).toBe(4);
  });

  it("truncates markdown to 20k chars", async () => {
    const huge = "<p>" + "x".repeat(40_000) + "</p>";
    mockFetch(() => ({ body: `<html><title>Big</title><body>${huge}</body></html>` }));
    const out = await prefetchUrls(["https://big.com"]);
    expect(out[0].markdown.length).toBeLessThanOrEqual(20_000);
  });

  it("strips scripts/styles via turndown.remove", async () => {
    mockFetch(() => ({
      body:
        "<html><title>Z</title><body><script>alert(1)</script><style>.x{}</style><p>visible</p></body></html>",
    }));
    const out = await prefetchUrls(["https://z.com"]);
    expect(out[0].markdown).toContain("visible");
    expect(out[0].markdown).not.toContain("alert(1)");
    expect(out[0].markdown).not.toContain(".x{}");
  });
});

describe("urlCitationId", () => {
  it("is deterministic per url", async () => {
    const a = await urlCitationId("https://x.com");
    const b = await urlCitationId("https://x.com");
    expect(a).toBe(b);
  });

  it("differs per distinct url", async () => {
    const a = await urlCitationId("https://x.com");
    const b = await urlCitationId("https://y.com");
    expect(a).not.toBe(b);
  });

  it("returns a uuidv5-shaped string", async () => {
    const id = await urlCitationId("https://x.com");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { upstream } from "./upstream-mock";

const { resetTakoClientForTests } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/client"
);
const { takoSearchHandler } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/search"
);

const savedToken = process.env.TAKO_API_TOKEN;

beforeEach(() => {
  delete process.env.TAKO_API_TOKEN;
  resetTakoClientForTests();
  upstream.reset();
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.TAKO_API_TOKEN;
  else process.env.TAKO_API_TOKEN = savedToken;
});

describe("takoSearchHandler", () => {
  it("forwards query + sources upstream and maps the result", async () => {
    upstream.response = {
      content: [{ type: "text", text: "search summary" }],
      structuredContent: {
        cards: [
          {
            title: "NVDA Revenue",
            webpage_url: "https://tako.com/card/nvda",
            embed_url: "https://embed.tako.com/nvda",
          },
        ],
        web_results: [],
      },
      isError: false,
    };
    const res = await takoSearchHandler({ query: "nvidia revenue", sources: ["data"] });
    expect(upstream.calls).toEqual([
      { name: "tako_search", args: { query: "nvidia revenue", sources: ["data"] } },
    ]);
    expect(res.content.some((i) => i.text.includes('"artifact"'))).toBe(true);
    expect(res.content.some((i) => i.text.includes('"citation"'))).toBe(true);
  });

  it("omits sources upstream when not supplied", async () => {
    await takoSearchHandler({ query: "us gdp" });
    expect(upstream.calls[0]?.args).toEqual({ query: "us gdp" });
  });

  it("returns upstream error text with the free-tier hint on isError", async () => {
    upstream.response = {
      content: [{ type: "text", text: "Rate limit exceeded" }],
      structuredContent: undefined,
      isError: true,
    };
    const res = await takoSearchHandler({ query: "x" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toContain("Rate limit exceeded");
    expect(res.content[0]?.text).toContain("TAKO_API_TOKEN");
  });

  it("surfaces a persistent transport error as a text item, never a crash", async () => {
    upstream.errors.push(new Error("connect ECONNREFUSED"), new Error("connect ECONNREFUSED"));
    const res = await takoSearchHandler({ query: "x" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toContain("Tako search failed");
    expect(res.content[0]?.text).toContain("ECONNREFUSED");
  });
});

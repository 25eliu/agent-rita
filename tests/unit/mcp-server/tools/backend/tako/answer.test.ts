import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { upstream } from "./upstream-mock";

const { resetTakoClientForTests } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/client"
);
const { takoAnswerHandler } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/answer"
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

describe("takoAnswerHandler", () => {
  it("forwards the query and maps markdown links to citations", async () => {
    upstream.response = {
      content: [{ type: "text", text: "US GDP grew 2.8% in 2024 [BEA](https://bea.gov/gdp)." }],
      structuredContent: { request_id: "r1", usage: null },
      isError: false,
    };
    const res = await takoAnswerHandler({ query: "What was US GDP growth in 2024?" });
    expect(upstream.calls).toEqual([
      { name: "tako_answer", args: { query: "What was US GDP growth in 2024?" } },
    ]);
    expect(res.content[0]?.text).toContain("2.8%");
    const citation = res.content.find((i) => i.text.includes('"citation"'));
    expect(citation).toBeDefined();
    expect(citation?.text).toContain("https://bea.gov/gdp");
  });

  it("returns hinted error text on isError", async () => {
    upstream.response = {
      content: [{ type: "text", text: "Rate limited" }],
      structuredContent: undefined,
      isError: true,
    };
    const res = await takoAnswerHandler({ query: "x" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toContain("Rate limited");
    expect(res.content[0]?.text).toContain("TAKO_API_TOKEN");
  });

  it("surfaces persistent errors as text", async () => {
    upstream.errors.push(new Error("boom"), new Error("boom"));
    const res = await takoAnswerHandler({ query: "x" });
    expect(res.content[0]?.text).toContain("Tako answer failed");
  });
});

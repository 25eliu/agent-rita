import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { upstream } from "./upstream-mock";

const { resetTakoClientForTests } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/client"
);
const { takoAvailableDataHandler } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/available-data"
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

describe("takoAvailableDataHandler", () => {
  it("forwards q + coverage_filter and passes text through", async () => {
    upstream.response = {
      content: [{ type: "text", text: "Coverage for Carnival: revenue, passenger cruise days" }],
      structuredContent: undefined,
      isError: false,
    };
    const res = await takoAvailableDataHandler({ q: "Carnival", coverage_filter: "cruise days" });
    expect(upstream.calls).toEqual([
      { name: "tako_available_data", args: { q: "Carnival", coverage_filter: "cruise days" } },
    ]);
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toContain("Coverage for Carnival");
  });

  it("omits coverage_filter when absent", async () => {
    await takoAvailableDataHandler({ q: "Nvidia" });
    expect(upstream.calls[0]?.args).toEqual({ q: "Nvidia" });
  });

  it("surfaces persistent errors as text", async () => {
    upstream.errors.push(new Error("down"), new Error("down"));
    const res = await takoAvailableDataHandler({ q: "x" });
    expect(res.content[0]?.text).toContain("Tako coverage lookup failed");
  });
});

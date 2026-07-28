import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { upstream } from "./upstream-mock";
import {
  isTakoEnabled,
  isTakoAuthed,
  withFreeTierHint,
  callTakoTool,
  resetTakoClientForTests,
} from "../../../../../../mcp-server/src/tools/backend/tako/client";

const savedEnv = {
  TAKO_ENABLED: process.env.TAKO_ENABLED,
  TAKO_API_TOKEN: process.env.TAKO_API_TOKEN,
  TAKO_MCP_URL: process.env.TAKO_MCP_URL,
};

beforeEach(() => {
  delete process.env.TAKO_ENABLED;
  delete process.env.TAKO_API_TOKEN;
  delete process.env.TAKO_MCP_URL;
  resetTakoClientForTests();
  upstream.reset();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("gating helpers", () => {
  it("isTakoEnabled defaults true, false only on the literal string 'false'", () => {
    expect(isTakoEnabled()).toBe(true);
    process.env.TAKO_ENABLED = "false";
    expect(isTakoEnabled()).toBe(false);
    process.env.TAKO_ENABLED = "true";
    expect(isTakoEnabled()).toBe(true);
  });

  it("isTakoAuthed reflects TAKO_API_TOKEN presence", () => {
    expect(isTakoAuthed()).toBe(false);
    process.env.TAKO_API_TOKEN = "tk-123";
    expect(isTakoAuthed()).toBe(true);
  });

  it("withFreeTierHint appends the hint only when unauthed", () => {
    expect(withFreeTierHint("msg")).toContain("TAKO_API_TOKEN");
    process.env.TAKO_API_TOKEN = "tk-123";
    expect(withFreeTierHint("msg")).toBe("msg");
  });
});

describe("callTakoTool", () => {
  it("connects lazily, joins text items, passes structured + isError through", async () => {
    upstream.response = {
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
      structuredContent: { cards: [] },
      isError: false,
    };
    const res = await callTakoTool("tako_search", { query: "gdp" });
    expect(upstream.connects).toBe(1);
    expect(upstream.calls).toEqual([{ name: "tako_search", args: { query: "gdp" } }]);
    expect(res.text).toBe("line one\nline two");
    expect(res.structured).toEqual({ cards: [] });
    expect(res.isError).toBe(false);
  });

  it("reuses the client across calls (singleton)", async () => {
    await callTakoTool("tako_search", { query: "a" });
    await callTakoTool("tako_answer", { query: "b" });
    expect(upstream.connects).toBe(1);
  });

  it("uses the default endpoint and honors TAKO_MCP_URL override", async () => {
    await callTakoTool("tako_search", { query: "x" });
    expect(upstream.transportUrls[0]).toBe("https://mcp.tako.com/mcp");
    resetTakoClientForTests();
    process.env.TAKO_MCP_URL = "http://localhost:9999/mcp";
    await callTakoTool("tako_search", { query: "x" });
    expect(upstream.transportUrls[1]).toBe("http://localhost:9999/mcp");
  });

  it("reconnects once when the call throws, then succeeds", async () => {
    upstream.errors.push(new Error("session expired"));
    const res = await callTakoTool("tako_search", { query: "x" });
    expect(res.text).toBe("upstream text");
    expect(upstream.connects).toBe(2);
  });

  it("throws when both attempts fail", async () => {
    upstream.errors.push(new Error("down"), new Error("down"));
    await expect(callTakoTool("tako_search", { query: "x" })).rejects.toThrow("down");
  });
});

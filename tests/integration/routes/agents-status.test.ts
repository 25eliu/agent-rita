/**
 * Tier 2 — agents.json + status route smoke.
 * No LLM, no DB, no MCP. Just shape + headers.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { agentsRouter } from "../../../src/routes/agents";
import { statusRouter } from "../../../src/routes/status";

function app() {
  const a = new Hono();
  a.route("/", agentsRouter);
  a.route("/", statusRouter);
  return a;
}

describe("GET /agents.json", () => {
  it("returns the openbb_agent_rita descriptor", async () => {
    const res = await app().request("/agents.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { openbb_agent_rita: Record<string, unknown> };
    expect(body.openbb_agent_rita.name).toBe("Agent Rita");
    expect(body.openbb_agent_rita).toHaveProperty("endpoints");
    expect(body.openbb_agent_rita).toHaveProperty("features");
  });

  it("advertises the supported feature flags", async () => {
    const res = await app().request("/agents.json");
    const body = (await res.json()) as {
      openbb_agent_rita: { features: Record<string, boolean> };
    };
    const features = body.openbb_agent_rita.features;
    expect(features.streaming).toBe(true);
    expect(features["mcp-tools"]).toBe(true);
    expect(features["generative-ui"]).toBe(true);
    expect(features["prompt-suggestions"]).toHaveProperty("label");
    expect(features["model"]).toHaveProperty("type", "select");
  });
});

describe("GET /status", () => {
  it("returns 200 with status: ok and an ISO timestamp", async () => {
    const res = await app().request("/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; timestamp: string };
    expect(body.status).toBe("ok");
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
  });
});

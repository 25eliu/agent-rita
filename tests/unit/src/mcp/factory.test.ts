import { describe, it, expect } from "bun:test";
import { makeMcpTools } from "../../../../src/mcp/factory";
import type { AgentTool } from "../../../../src/protocol/types";

function tool(overrides: Partial<AgentTool>): AgentTool {
  return {
    name: "tool",
    server_id: "srv",
    url: "u",
    ...overrides,
  };
}

describe("makeMcpTools — sanitization", () => {
  it("renames tool names to safe identifiers", () => {
    const out = makeMcpTools([tool({ name: "fetch-webpage" })]);
    expect(out.entries[0].sanitizedName).toBe("fetch_webpage");
    expect(Object.keys(out.toolSet)).toContain("fetch_webpage");
  });

  it("dedupes sanitized collisions with numeric suffixes", () => {
    const out = makeMcpTools([
      tool({ name: "do_thing", server_id: "a" }),
      tool({ name: "do-thing", server_id: "b" }),
      tool({ name: "do.thing", server_id: "c" }),
    ]);
    expect(out.entries.map((e) => e.sanitizedName)).toEqual(["do_thing", "do_thing_2", "do_thing_3"]);
  });
});

describe("makeMcpTools — entries", () => {
  it("preserves serverId, original toolName, and description", () => {
    const out = makeMcpTools([
      tool({ name: "fetch-webpage", server_id: "rita", description: "Fetch a page" }),
    ]);
    expect(out.entries[0]).toMatchObject({
      serverId: "rita",
      toolName: "fetch-webpage",
      sanitizedName: "fetch_webpage",
      description: "Fetch a page",
    });
  });

  it("falls back description to the original tool name when missing", () => {
    const out = makeMcpTools([tool({ name: "x", description: undefined })]);
    expect(out.entries[0].description).toBe("x");
  });
});

describe("makeMcpTools — round-trip nature", () => {
  it("registered tools have NO execute (loop owns dispatch)", () => {
    const out = makeMcpTools([tool({ name: "x" })]);
    expect((out.toolSet.x as { execute?: unknown }).execute).toBeUndefined();
  });
});

describe("makeMcpTools — stopCondition", () => {
  const out = makeMcpTools([tool({ name: "fetch-webpage" })]);

  it("stops when the last step calls a registered MCP tool", () => {
    const result = (out.stopCondition as unknown as (a: { steps: Array<{ toolCalls: Array<{ toolName: string }> }> }) => boolean)({
      steps: [{ toolCalls: [{ toolName: "fetch_webpage" }] }],
    });
    expect(result).toBe(true);
  });

  it("does not stop when the last step calls a non-MCP tool", () => {
    const result = (out.stopCondition as unknown as (a: { steps: Array<{ toolCalls: Array<{ toolName: string }> }> }) => boolean)({
      steps: [{ toolCalls: [{ toolName: "search_widgets" }] }],
    });
    expect(result).toBe(false);
  });

  it("does not stop when there are no steps", () => {
    const result = (out.stopCondition as unknown as (a: { steps: never[] }) => boolean)({ steps: [] });
    expect(result).toBe(false);
  });
});

describe("makeMcpTools — isMcpToolName", () => {
  it("matches sanitized names only", () => {
    const out = makeMcpTools([tool({ name: "fetch-webpage" })]);
    expect(out.isMcpToolName("fetch_webpage")).toBe(true);
    expect(out.isMcpToolName("fetch-webpage")).toBe(false);
    expect(out.isMcpToolName("anything_else")).toBe(false);
  });
});

describe("makeMcpTools — input schema strips x-agentrita-*", () => {
  it("hides decoration keys from the model-facing input schema", () => {
    const out = makeMcpTools([
      tool({
        name: "execute_code",
        input_schema: {
          properties: {
            code: { type: "string" },
            "x-agentrita-tables": { type: "object" },
            "x-agentrita-conversation-id": { type: "string" },
          },
          required: ["code"],
        },
      }),
    ]);
    const t = out.toolSet.execute_code as unknown as { inputSchema: { shape: Record<string, unknown> } };
    const keys = Object.keys(t.inputSchema.shape);
    expect(keys).toContain("code");
    expect(keys).toContain("display_summary");
    expect(keys).not.toContain("x-agentrita-tables");
    expect(keys).not.toContain("x-agentrita-conversation-id");
  });
});

describe("makeMcpTools — agent-owned tool names filtered", () => {
  it("drops MCP wrappers whose name matches a vendored bridge command", () => {
    const out = makeMcpTools([
      tool({ name: "manage_dashboard", server_id: "rita" }),
      tool({ name: "create_widget", server_id: "rita" }),
      tool({ name: "fetch_webpage", server_id: "rita" }),
    ]);
    expect(out.entries.map((e) => e.toolName).sort()).toEqual(["fetch_webpage"]);
    expect(Object.keys(out.toolSet)).toEqual(["fetch_webpage"]);
  });

  it("drops MCP wrappers whose name matches an agent SQL tool", () => {
    const out = makeMcpTools([
      tool({ name: "execute_sql", server_id: "rita" }),
      tool({ name: "peek_table", server_id: "rita" }),
      tool({ name: "create_artifact", server_id: "rita" }),
      tool({ name: "fetch_webpage", server_id: "rita" }),
    ]);
    expect(out.entries.map((e) => e.toolName).sort()).toEqual(["fetch_webpage"]);
  });

  it("matches workspace's server-slug-prefixed names too", () => {
    const out = makeMcpTools([
      tool({ name: "agentritamcp_manage_dashboard", server_id: "rita" }),
      tool({ name: "agentritamcp_execute_sql", server_id: "rita" }),
      tool({ name: "agentritamcp_fetch_webpage", server_id: "rita" }),
    ]);
    expect(out.entries.map((e) => e.toolName)).toEqual(["agentritamcp_fetch_webpage"]);
  });

  // The bridge mount names `update_widget_layout` differently from its wire
  // command (`update_dashboard_layout`), and get_widget_data/get_skill_content
  // are bridge commands with bespoke agent paths outside WORKSPACE_BRIDGE_COMMANDS.
  // All three must still be deduped or they double-register against native tools
  // (and update_widget_layout leaks a mutation path when generative UI is off).
  it("drops bridge-mount aliases and bespoke round-trip wrappers", () => {
    const out = makeMcpTools([
      tool({ name: "agentritamcp_update_widget_layout", server_id: "rita" }),
      tool({ name: "agentritamcp_get_widget_data", server_id: "rita" }),
      tool({ name: "agentritamcp_get_skill_content", server_id: "rita" }),
      tool({ name: "agentritamcp_web_search", server_id: "rita" }),
    ]);
    expect(out.entries.map((e) => e.toolName)).toEqual(["agentritamcp_web_search"]);
  });
});

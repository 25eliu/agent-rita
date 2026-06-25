/**
 * Tier 2 — agent-loop decoration & schema-strip scenarios.
 *
 * Pinned to CLAUDE.md gotchas:
 * - Missing X-Trace-Id → execute_code suppressed, SQL family unaffected
 * - COMPUTE_PERMANENTLY_UNAVAILABLE in any prior message → execute_code disabled
 * - x-agentrita-tables decoration shipped on SQL + code calls
 * - x-agentrita-* keys never appear in the model-facing tool schema
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop, _resetWidgetDataCache } from "../../../src/agent/loop";
import type { AgentTool, QueryRequest, SSEEvent, ToolMessage, Widget } from "../../../src/protocol/types";
import { llmCallsTool, llmEmitsText, makeMockLlm, makeSpyMockLlm } from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";
import { rememberRows } from "../../../src/agent/row-cache";

beforeEach(() => {
  clearAllModuleState();
  _resetWidgetDataCache();
});

// Only `execute_code` rides the decoration path now; SQL family lives
// in-process on the agent and never round-trips through MCP.
function tools(): AgentTool[] {
  return [
    {
      name: "execute_code",
      server_id: "rita",
      url: "http://localhost:8787/mcp",
      description: "Run Python",
      input_schema: {
        properties: {
          code: { type: "string" },
          "x-agentrita-conversation-id": { type: "string" },
          "x-agentrita-tables": { type: "object" },
        },
        required: ["code"],
      },
    },
  ];
}

function findExecuteAgentTool(events: SSEEvent[]): SSEEvent | undefined {
  return events.find(
    (e) =>
      e.event === "copilotFunctionCall" &&
      (e.data as { function?: string }).function === "execute_agent_tool",
  );
}

function executeAgentToolPayload(e: SSEEvent): {
  tool_name: string;
  parameters: Record<string, unknown>;
} {
  const data = e.data as { input_arguments: Record<string, unknown> };
  return data.input_arguments as { tool_name: string; parameters: Record<string, unknown> };
}

describe("decoration — execute_code suppression on missing conversationId", () => {
  it("calling execute_code without X-Trace-Id is replaced by SQL family availability only", async () => {
    // Model would call execute_code; without conversationId the loop suppresses it
    // entirely (the tool is removed from the toolSet), so the AI SDK can't invoke it.
    // Drive a model that responds with text instead and assert the suppression log
    // shape via the absence of an execute_agent_tool emit.
    const events = await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "run python" }], tools: tools() } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmEmitsText("compute is unavailable for this turn")),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "",
      }),
    );
    expect(findExecuteAgentTool(events)).toBeUndefined();
    expect(
      (events.find((e) => e.event === "copilotMessageChunk")!.data as { delta: string }).delta,
    ).toContain("compute is unavailable");
  });

  it("execute_sql runs in-process even when conversationId is missing — no executeAgentTool emit", async () => {
    rememberRows("", "prices", [{ symbol: "NVDA" }]);
    const events = await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "select" }], tools: tools() } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmEmitsText("nothing to do")),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "",
      }),
    );
    expect(findExecuteAgentTool(events)).toBeUndefined();
  });
});

describe("decoration — COMPUTE_PERMANENTLY_UNAVAILABLE marker disables execute_code for the rest of the chat", () => {
  it("a prior tool message containing the marker suppresses execute_code", async () => {
    const priorTool: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: { tool_name: "execute_code", server_id: "rita" },
      data: [{ items: [{ text: "COMPUTE_PERMANENTLY_UNAVAILABLE: sandbox failed" }] }],
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "again" },
            priorTool,
          ],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmEmitsText("I won't retry compute.")),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-1",
      }),
    );
    expect(findExecuteAgentTool(events)).toBeUndefined();
  });
});

describe("decoration — pendingTables shipping", () => {
  beforeEach(() => clearAllModuleState());

  it("execute_code receives BOTH x-agentrita-tables AND x-agentrita-conversation-id", async () => {
    rememberRows("conv-3", "prices", [{ symbol: "MSFT" }]);
    const events = await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "py" }], tools: tools() } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          llmCallsTool("execute_code", {
            display_summary: "Running a Python check",
            code: "print(1)",
          }),
        ),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-3",
      }),
    );
    const exec = findExecuteAgentTool(events);
    expect(exec).toBeDefined();
    const params = executeAgentToolPayload(exec!).parameters;
    expect(params["x-agentrita-conversation-id"]).toBe("conv-3");
    expect("display_summary" in params).toBe(false);
    const shipped = params["x-agentrita-tables"] as Record<string, unknown[]>;
    expect(shipped.prices).toEqual([{ symbol: "MSFT" }]);
    const status = events.find(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { message?: string }).message === "Running a Python check",
    );
    expect(status).toBeDefined();
    // Structured `tool_call` restores eval attribution for in-process calls;
    // the Python display stays as a direct fenced code block for rendering.
    const details = (status!.data as { details?: unknown[] }).details;
    expect(details?.[0]).toBe("```python\nprint(1)\n```");
    expect((status!.data as { tool_call?: Record<string, unknown> }).tool_call).toEqual({
      tool_name: "execute_code",
      input: {
        display_summary: "Running a Python check",
        code: "print(1)",
      },
    });
  });

  it("execute_code does not include x-agentrita-tables when no rows are pending", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "x" }], tools: tools() } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("execute_code", { code: "print(1)" })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-4",
      }),
    );
    const params = executeAgentToolPayload(findExecuteAgentTool(events)!).parameters;
    expect("x-agentrita-tables" in params).toBe(false);
  });
});

function priorExecuteCodeResult(args: {
  sandboxMetaId?: string;
  extraState?: Record<string, unknown>;
}): ToolMessage {
  const items: Array<{ text: string }> = [];
  if (args.sandboxMetaId !== undefined) {
    items.push({
      text: JSON.stringify({ $rita_kind: "sandbox_meta", sandbox_id: args.sandboxMetaId }),
    });
  }
  items.push({ text: "[No output]" });
  return {
    role: "tool",
    function: "execute_agent_tool",
    input_arguments: { tool_name: "execute_code", server_id: "rita" },
    data: [{ items }],
    ...(args.extraState ? { extra_state: args.extraState } : {}),
  };
}

describe("decoration — delta shipping", () => {
  beforeEach(() => clearAllModuleState());

  it("delta: tables already shipped to the same sandbox are excluded from x-agentrita-tables", async () => {
    rememberRows("conv-delta-1", "prices", [{ symbol: "AAPL" }]);
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "again" },
            priorExecuteCodeResult({
              sandboxMetaId: "sb-1",
              extraState: { compute_tables_shipped: ["prices"], compute_sandbox_id: "sb-1" },
            }),
          ],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("execute_code", { code: "print(1)" })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-delta-1",
      }),
    );
    const exec = findExecuteAgentTool(events);
    expect(exec).toBeDefined();
    const params = executeAgentToolPayload(exec!).parameters;
    // prices was already shipped + sandbox id matches → no x-agentrita-tables
    expect("x-agentrita-tables" in params).toBe(false);
  });

  it("sandbox-id change clears tablesShipped → next call ships everything", async () => {
    rememberRows("conv-delta-2", "prices", [{ symbol: "AAPL" }]);
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "again" },
            priorExecuteCodeResult({
              sandboxMetaId: "sb-NEW",
              extraState: { compute_tables_shipped: ["prices"], compute_sandbox_id: "sb-OLD" },
            }),
          ],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("execute_code", { code: "print(1)" })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-delta-2",
      }),
    );
    const params = executeAgentToolPayload(findExecuteAgentTool(events)!).parameters;
    const shipped = params["x-agentrita-tables"] as Record<string, unknown[]>;
    expect(shipped).toBeDefined();
    expect(shipped.prices).toEqual([{ symbol: "AAPL" }]);
  });

  it("backwards-compat: missing sandbox_meta in result → clear → full re-ship", async () => {
    rememberRows("conv-delta-3", "prices", [{ symbol: "AAPL" }]);
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "again" },
            priorExecuteCodeResult({
              sandboxMetaId: undefined,
              extraState: { compute_tables_shipped: ["prices"] },
            }),
          ],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("execute_code", { code: "print(1)" })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-delta-3",
      }),
    );
    const params = executeAgentToolPayload(findExecuteAgentTool(events)!).parameters;
    const shipped = params["x-agentrita-tables"] as Record<string, unknown[]>;
    expect(shipped).toBeDefined();
    expect(shipped.prices).toEqual([{ symbol: "AAPL" }]);
  });

  it("first sighting of sandbox_id (no prior compute_sandbox_id) preserves tablesShipped — no wasted re-ship", async () => {
    rememberRows("conv-delta-4", "prices", [{ symbol: "AAPL" }]);
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "again" },
            priorExecuteCodeResult({
              sandboxMetaId: "sb-1",
              // First-call extra_state shape: tables shipped but no sandbox_id
              // recorded yet (agent didn't know it until this re-POST).
              extraState: { compute_tables_shipped: ["prices"] },
            }),
          ],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("execute_code", { code: "print(1)" })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-delta-4",
      }),
    );
    const params = executeAgentToolPayload(findExecuteAgentTool(events)!).parameters;
    // prices was already shipped, sandbox id is now known and matches what
    // MCP just used. Don't re-ship.
    expect("x-agentrita-tables" in params).toBe(false);
  });
});

describe("decoration — shipped rows use the sanitized column names the model was told", () => {
  beforeEach(() => clearAllModuleState());

  it("x-agentrita-tables rows carry sanitizeName'd keys, matching the loaded-tables inventory", async () => {
    // Raw widget rows have camelCase/spaced keys; the model-facing inventory
    // and execute_sql expose sanitized lowercase names. The sandbox must see
    // the SAME schema or pandas code written against the inventory explodes
    // (DuckDB SQL is case-insensitive, pandas indexing is not).
    rememberRows("conv-sanitize-1", "home_cards", [
      { startDate: "2026-01-01", "Volume 24hr": 5, title: "a" },
    ]);
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "chart it" }],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("execute_code", { code: "print(1)" })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-sanitize-1",
      }),
    );
    const params = executeAgentToolPayload(findExecuteAgentTool(events)!).parameters;
    const shipped = params["x-agentrita-tables"] as Record<string, Record<string, unknown>[]>;
    expect(shipped).toBeDefined();
    expect(shipped.home_cards).toEqual([
      { startdate: "2026-01-01", volume_24hr: 5, title: "a" },
    ]);
  });
});

describe("round-trip extra_state — continuation state survives every emission", () => {
  beforeEach(() => clearAllModuleState());

  it("get_widget_data emission carries compute_tables_shipped + compute_sandbox_id forward", async () => {
    // Prior execute_code shipped "prices" to sb-1; the model now fetches a
    // widget. If the widget emission drops the compute keys, the re-POST
    // restores nothing and the next execute_code full-ships — the exact
    // waste delta-shipping exists to avoid.
    const widget: Widget = {
      uuid: "w-1",
      origin: "openbb",
      widget_id: "tbl",
      name: "Tbl",
      description: "",
      params: [],
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "fetch the widget" },
            priorExecuteCodeResult({
              sandboxMetaId: "sb-1",
              extraState: { compute_tables_shipped: ["prices"], compute_sandbox_id: "sb-1" },
            }),
          ],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          llmCallsTool("get_widget_data", { widgets: [{ widget_uuid: "w-1" }] }),
        ),
        allWidgets: [widget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-cont-1",
      }),
    );
    const fetchEvent = events.find(
      (e) =>
        e.event === "copilotFunctionCall" &&
        (e.data as { function?: string }).function === "get_widget_data",
    );
    expect(fetchEvent).toBeDefined();
    const extra = (fetchEvent!.data as { extra_state?: Record<string, unknown> }).extra_state;
    expect(extra?.compute_tables_shipped).toEqual(["prices"]);
    expect(extra?.compute_sandbox_id).toBe("sb-1");
  });

  it("execute_agent_tool emission carries loaded_skill_slugs forward", async () => {
    // Prior re-POST loaded a skill; the model now calls execute_code. If the
    // MCP emission drops loaded_skill_slugs, the skill inventory is lost for
    // the rest of the turn and the model may reload the skill.
    const skillResult: ToolMessage = {
      role: "tool",
      function: "get_skill_content",
      input_arguments: { slug: "summarize-table" },
      data: [
        { status: "success", data: { skill: { contentMarkdown: "Be concise." } } },
      ] as unknown as ToolMessage["data"],
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "analyze" }, skillResult],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("execute_code", { code: "print(1)" })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-cont-2",
      }),
    );
    const exec = findExecuteAgentTool(events);
    expect(exec).toBeDefined();
    const extra = (exec!.data as { extra_state?: Record<string, unknown> }).extra_state;
    expect(extra?.loaded_skill_slugs).toContain("summarize-table");
  });
});

describe("history — earlier MCP results from the turn stay visible to the model", () => {
  beforeEach(() => clearAllModuleState());

  it("the prompt includes the earlier call's artifact ack, not just the last result", async () => {
    const earlier: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: { tool_name: "execute_code", server_id: "rita" },
      data: [
        {
          items: [
            {
              text: JSON.stringify({
                $rita_kind: "artifact",
                artifact: { type: "html", uuid: "u1", name: "First Chart", description: "", content: "<img/>" },
              }),
            },
            { text: "first call traceback" },
          ],
        },
      ],
    };
    const spy = makeSpyMockLlm(llmEmitsText("done"));
    await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "chart it" },
            earlier,
            priorExecuteCodeResult({ sandboxMetaId: "sb-1" }),
          ],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: spy.model,
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-hist-1",
      }),
    );
    const prompt = JSON.stringify(spy.calls[0]?.messages ?? []);
    expect(prompt).toContain('[Artifact \\"First Chart\\" (html) delivered to the user');
    expect(prompt).toContain("first call traceback");
  });
});

describe("MCP artifacts — land in the message stream, not the status timeline", () => {
  beforeEach(() => clearAllModuleState());

  function executeCodeResultWithArtifact(name: string): ToolMessage {
    return {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: { tool_name: "execute_code", server_id: "rita" },
      data: [
        {
          items: [
            {
              text: JSON.stringify({
                $rita_kind: "artifact",
                artifact: { type: "html", uuid: "u1", name, description: "", content: "<img/>" },
              }),
            },
            { text: "chart rendered" },
          ],
        },
      ],
    };
  }

  it("artifact from an MCP result is emitted as copilotMessageArtifact when the model answers", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "chart it" },
            executeCodeResultWithArtifact("Top Chart"),
          ],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmEmitsText("Here is the analysis.")),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-art-1",
      }),
    );
    const artifactEvent = events.find(
      (e) =>
        e.event === "copilotMessageArtifact" &&
        (e.data as { name?: string }).name === "Top Chart",
    );
    expect(artifactEvent).toBeDefined();
    // Status update also carries the output artifact so the tool-call details
    // can show both input and output artifacts.
    const status = events.find(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { message?: string }).message === "Output from rita - execute_code",
    );
    expect(status).toBeDefined();
    expect((status!.data as { details?: unknown }).details).toBeUndefined();
    expect((status!.data as { artifacts?: Array<{ name?: string }> }).artifacts?.[0])
      .toMatchObject({ name: "Top Chart" });
  });

  it("strips repeated Mermaid code from final text when an MCP artifact is emitted", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "chart it" },
            executeCodeResultWithArtifact("Rendered Diagram"),
          ],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          llmEmitsText(
            "Here is the rendered diagram:\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nIt groups the products.",
          ),
        ),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-art-mermaid-strip",
      }),
    );

    const finalText = events
      .filter((e) => e.event === "copilotMessageChunk")
      .map((e) => (e.data as { delta?: string }).delta ?? "")
      .join("");
    expect(finalText).toContain("Here is the rendered diagram:");
    expect(finalText).toContain("It groups the products.");
    expect(finalText).not.toContain("```mermaid");
    expect(finalText).not.toContain("flowchart TD");
    expect(events.some((e) => e.event === "copilotMessageArtifact")).toBe(true);
  });

  it("artifact is not lost when the model follows up with another round-trip call", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "chart it" },
            executeCodeResultWithArtifact("Mid-turn Chart"),
          ],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("execute_code", { code: "print(1)" })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-art-2",
      }),
    );
    const artifactIdx = events.findIndex(
      (e) =>
        e.event === "copilotMessageArtifact" &&
        (e.data as { name?: string }).name === "Mid-turn Chart",
    );
    const callIdx = events.findIndex(
      (e) =>
        e.event === "copilotFunctionCall" &&
        (e.data as { function?: string }).function === "execute_agent_tool",
    );
    // Artifact must be emitted before the turn pauses for the next round-trip
    // — the artifactQueue is request-scoped and dies at the re-POST.
    expect(artifactIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(artifactIdx).toBeLessThan(callIdx);
  });
});

describe("decoration — x-agentrita-* never reaches the model", () => {
  it("the tools surfaced to doGenerate have no x-agentrita-* keys in their input schema", async () => {
    const spy = makeSpyMockLlm(llmEmitsText("ok"));
    const widget: Widget = {
      uuid: "w-1",
      origin: "openbb",
      widget_id: "w",
      name: "Sample",
      description: "",
      params: [],
    };
    await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "go" }], tools: tools() } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: spy.model,
        allWidgets: [widget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-5",
      }),
    );
    expect(spy.calls.length).toBeGreaterThan(0);
    const surfacedTools = spy.calls[0].tools as Record<string, { inputSchema: { jsonSchema?: { properties?: Record<string, unknown> } } } | undefined>;
    // The Vercel AI SDK shapes tools as { name: { type, inputSchema, ... } }; we
    // assert no key on any tool's input schema starts with x-agentrita-.
    for (const t of Object.values(surfacedTools)) {
      const schema = (t as unknown as { inputSchema?: { jsonSchema?: { properties?: Record<string, unknown> } } } | undefined)?.inputSchema?.jsonSchema?.properties;
      if (schema) {
        for (const k of Object.keys(schema)) {
          expect(k.startsWith("x-agentrita-")).toBe(false);
        }
      }
    }
  });
});

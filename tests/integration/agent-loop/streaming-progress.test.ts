/**
 * Tier 2 — live progress during a no-round-trip in-process tool chain.
 *
 * Regression guard for the streamText migration (loop.ts). When the model
 * runs in-process tools (execute_sql, create_artifact — both have `execute`,
 * neither round-trips) and then answers, the loop must surface each tool as a
 * structured reasoning step as it completes. The rendered answer artifact is
 * deferred until the model finishes any follow-up tool work, but the reasoning
 * status carries the artifact payload immediately so step-by-step progress can
 * continue without the chart interrupting the trace. The old `generateText`
 * path walked `result.steps` only after the whole call finished, so an all-
 * in-process workflow showed no progress (the reported "stuck on Analyzing
 * your question..." hang).
 *
 * The interleave assertions are narrow harness-contract checks. The mock fixes
 * the tool order deterministically, so these assert harness emission behavior,
 * not the model's reasoning order (which the test discipline rightly forbids pinning).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop } from "../../../src/agent/loop";
import type { AgentTool, Citation, QueryRequest, SSEEvent, ToolMessage, Widget } from "../../../src/protocol/types";
import { llmCallsTool, llmCallsToolWithText, llmEmitsText, makeSequencedMockLlm } from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";
import { rememberRows } from "../../../src/agent/row-cache";

beforeEach(() => clearAllModuleState());

function linqAlphaTools(): AgentTool[] {
  return [
    {
      name: "LinqAlpha_web_search",
      server_id: "LinqAlpha",
      url: "http://localhost:8787/mcp",
      description: "Search the web",
      input_schema: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: "LinqAlpha_cite_web_source",
      server_id: "LinqAlpha",
      url: "http://localhost:8787/mcp",
      description: "Create a web citation",
      input_schema: {
        properties: {
          url: { type: "string" },
          title: { type: "string" },
        },
        required: ["url", "title"],
      },
    },
  ];
}

function mermaidTools(): AgentTool[] {
  return [
    {
      name: "mermaid_diagram",
      server_id: "AgentRita",
      url: "http://localhost:8787/mcp",
      description: "Create a Mermaid diagram",
      input_schema: {
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          code: { type: "string" },
        },
        required: ["name", "description", "code"],
      },
    },
  ];
}

function reasoningToolNames(events: SSEEvent[]): string[] {
  const names: string[] = [];
  const inProcessTools = new Set(["execute_sql", "create_artifact"]);
  for (const e of events) {
    if (e.event !== "copilotStatusUpdate") continue;
    const message = (e.data as { message?: string }).message ?? "";
    const prefix = message.split(":")[0];
    if (inProcessTools.has(prefix)) names.push(prefix);
    const toolCall = (e.data as { tool_call?: { tool_name?: unknown } }).tool_call;
    if (typeof toolCall?.tool_name === "string") names.push(toolCall.tool_name);
    const details = (e.data as { details?: Array<Record<string, unknown>> }).details ?? [];
    for (const d of details) if (typeof d.tool_name === "string") names.push(d.tool_name);
  }
  return names;
}

describe("streaming — MCP tool calls surface input details", () => {
  it("shows MCP input parameters as details without an artifact when a round-trip tool starts", async () => {
    const query = "MacBook Neo reddit reaction site:reddit.com";
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "search reddit" }],
          tools: linqAlphaTools(),
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("LinqAlpha_web_search", { query }),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "stream-mcp-input-details",
      }),
    );

    const status = events.find(
      (event) =>
        event.event === "copilotStatusUpdate" &&
        (event.data as { message?: string }).message === `Searching "${query}"`,
    );
    expect(status).toBeDefined();
    expect((status!.data as { details?: Array<Record<string, unknown>> }).details).toEqual([
      { query },
    ]);
    expect((status!.data as { artifacts?: Array<Record<string, unknown>> }).artifacts)
      .toBeUndefined();
  });

  it("keeps direct input details for MCP citation progress", async () => {
    const input = {
      url: "https://reddit.com/r/apple/example",
      title: "MacBook Neo launch reaction thread",
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "cite reddit thread" }],
          tools: linqAlphaTools(),
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("LinqAlpha_cite_web_source", {
            ...input,
            display_summary: "Citing MacBook Neo launch reaction thread",
          }),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "stream-mcp-cite-input-details",
      }),
    );

    const status = events.find(
      (event) =>
        event.event === "copilotStatusUpdate" &&
        (event.data as { message?: string }).message === "Citing MacBook Neo launch reaction thread",
    );
    expect(status).toBeDefined();
    expect((status!.data as { details?: Array<Record<string, unknown>> }).details).toEqual([
      input,
    ]);
    expect((status!.data as { artifacts?: Array<Record<string, unknown>> }).artifacts)
      .toBeUndefined();
  });

  it("renders MCP Mermaid inputs as a code detail without metadata keys", async () => {
    const code = "flowchart TD\n  A[OpenBB] --> B[Workspace]";
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "render a product flowchart" }],
          tools: mermaidTools(),
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("mermaid_diagram", {
            name: "OpenBB Product Offerings Flowchart",
            description: "A flowchart diagram of OpenBB product offerings.",
            code,
          }),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "stream-mcp-mermaid-code-details",
      }),
    );

    const status = events.find(
      (event) =>
        event.event === "copilotStatusUpdate" &&
        (event.data as { message?: string }).message === "Calling mermaid_diagram",
    );
    expect(status).toBeDefined();
    expect((status!.data as { details?: string[] }).details).toEqual([
      `\`\`\`mermaid\n${code}\n\`\`\``,
    ]);
    expect(JSON.stringify((status!.data as { details?: unknown }).details)).not.toContain(
      "code",
    );
    expect(JSON.stringify((status!.data as { details?: unknown }).details)).not.toContain(
      "name",
    );
  });
});

describe("streaming — in-process tool chain surfaces progress live", () => {
  it("renders HTML artifact inputs as a code detail without input keys", async () => {
    const html = "<h2>OpenBB Product Offerings</h2>";
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "render an html artifact" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("create_html_artifact", {
            html,
            name: "OpenBB Product Offerings Diagram",
            description: "HTML diagram of OpenBB product offerings.",
          }),
          llmEmitsText("Rendered the diagram."),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        promptSuggestionsEnabled: false,
        conversationId: "stream-html-code-details",
      }),
    );

    const status = events.find(
      (event) =>
        event.event === "copilotStatusUpdate" &&
        (event.data as { message?: string }).message === "Rendering HTML artifact",
    );
    expect(status).toBeDefined();
    expect((status!.data as { details?: string[] }).details).toEqual([
      `\`\`\`html\n${html}\n\`\`\``,
    ]);
    expect(JSON.stringify((status!.data as { details?: unknown }).details)).not.toContain(
      "input_params",
    );
    expect(JSON.stringify((status!.data as { details?: unknown }).details)).not.toContain(
      "name",
    );
  });

  it("emits a structured reasoning step per in-process tool and attaches artifacts before the final answer", async () => {
    rememberRows("stream-prog-1", "prices", [
      { symbol: "NVDA", close: 100 },
      { symbol: "AAPL", close: 200 },
    ]);

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "summarize and chart prices" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        // Single streamText call, three internal steps, zero round-trips:
        // execute_sql → create_artifact → final text.
        model: makeSequencedMockLlm([
          llmCallsTool("execute_sql", {
            display_summary: "Checking the top close",
            sql: "SELECT MAX(close) AS m FROM prices",
          }),
          llmCallsTool("create_artifact", {
            display_summary: "Rendering the prices table",
            sql: "SELECT * FROM prices",
            artifact: { type: "table", name: "Prices", description: "loaded prices" },
          }),
          llmEmitsText("Top close is 200; table attached."),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "stream-prog-1",
      }),
    );

    // Both in-process tools surfaced as structured reasoning steps (the
    // contract the eval trace runner reads to attribute non-round-trip calls).
    const toolNames = reasoningToolNames(events);
    expect(toolNames).toContain("execute_sql");
    expect(toolNames).toContain("create_artifact");
    expect(
      events.find(
        (e) =>
          e.event === "copilotStatusUpdate" &&
          (e.data as { message?: string }).message ===
            "execute_sql returned a result",
      ),
    ).toBeUndefined();
    expect(
      events.find(
        (e) =>
          e.event === "copilotStatusUpdate" &&
          (e.data as { message?: string }).message ===
            'Rendered table artifact "Prices" from 2 rows.',
      ),
    ).toBeDefined();
    const sqlStartStatus = events.find(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { message?: string }).message === "Checking the top close",
    );
    expect(sqlStartStatus).toBeDefined();
    const sqlStartDetails = (sqlStartStatus!.data as { details?: string[] }).details;
    expect(sqlStartDetails).toEqual(["```sql\nSELECT MAX(close) AS m FROM prices\n```"]);
    expect((sqlStartStatus!.data as { tool_call?: Record<string, unknown> }).tool_call).toEqual({
      tool_name: "execute_sql",
      input: {
        display_summary: "Checking the top close",
        sql: "SELECT MAX(close) AS m FROM prices",
      },
    });
    // No round-trip happened — fully in-process.
    expect(
      events.find(
        (e) =>
          e.event === "copilotFunctionCall" &&
          (e.data as { function?: string }).function === "execute_agent_tool",
      ),
    ).toBeUndefined();

    const artifactResultStatusIdx = events.findIndex(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { message?: string }).message ===
          'Rendered table artifact "Prices" from 2 rows.',
    );
    const artifactEventIdx = events.findIndex((e) => e.event === "copilotMessageArtifact");
    const finalTextIdx = events.findIndex(
      (e) =>
        e.event === "copilotMessageChunk" &&
        (e.data as { delta: string }).delta.includes("Top close is 200"),
    );
    expect(artifactResultStatusIdx).toBeGreaterThanOrEqual(0);
    expect(artifactEventIdx).toBeGreaterThanOrEqual(0);
    expect(finalTextIdx).toBeGreaterThanOrEqual(0);
    const artifactStatus = events[artifactResultStatusIdx].data as {
      artifacts?: Array<{ type?: string; name?: string }>;
      details?: Array<Record<string, unknown>>;
    };
    expect(artifactStatus.artifacts?.[0]).toMatchObject({
      type: "table",
      name: "Prices",
    });
    expect(artifactStatus.details).toBeUndefined();
    const artifact = events[artifactEventIdx].data as { type: string; name: string; content: unknown[] };
    expect(artifact).toMatchObject({
      type: "table",
      name: "Prices",
    });
    expect(artifact.content.length).toBe(2);
    // The artifact status is visible before final text, while the answer
    // artifact is emitted in the final phase so it does not interrupt any
    // later tool reasoning.
    expect(artifactResultStatusIdx).toBeLessThan(finalTextIdx);
    expect(artifactEventIdx).toBeLessThan(finalTextIdx);
  });

  it("defers create_artifact answer events until later tool reasoning is complete", async () => {
    rememberRows("stream-artifact-defers", "prices", [
      { symbol: "NVDA", close: 100 },
      { symbol: "AAPL", close: 200 },
    ]);

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "chart and analyze prices" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("create_artifact", {
            display_summary: "Rendering the prices table",
            sql: "SELECT * FROM prices",
            artifact: { type: "table", name: "Prices", description: "loaded prices" },
          }),
          llmCallsTool("execute_sql", {
            display_summary: "Checking the top close",
            sql: "SELECT MAX(close) AS m FROM prices",
          }),
          llmEmitsText("Top close is 200; table attached."),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "stream-artifact-defers",
      }),
    );

    const artifactStatusIdx = events.findIndex(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { message?: string }).message === 'Rendered table artifact "Prices" from 2 rows.',
    );
    const executeStartIdx = events.findIndex(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { message?: string }).message === "Checking the top close",
    );
    const artifactEventIdx = events.findIndex((e) => e.event === "copilotMessageArtifact");
    const finalTextIdx = events.findIndex(
      (e) =>
        e.event === "copilotMessageChunk" &&
        (e.data as { delta: string }).delta.includes("Top close is 200"),
    );

    expect(artifactStatusIdx).toBeGreaterThanOrEqual(0);
    expect(executeStartIdx).toBeGreaterThan(artifactStatusIdx);
    expect(artifactEventIdx).toBeGreaterThan(executeStartIdx);
    expect(finalTextIdx).toBeGreaterThan(artifactEventIdx);
  });

  it("does not promote execute_sql text results to answer artifacts from user wording", async () => {
    const rows = Array.from({ length: 25 }, (_, idx) => ({
      date: `2024-01-${String(idx + 1).padStart(2, "0")}`,
      close: idx + 1,
    }));
    rememberRows("stream-sql-export-artifact", "prices", rows);

    const csv = [
      "date,close",
      ...rows.map((row) => `${row.date},${row.close}`),
    ].join("\n");

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "Export prices to CSV" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("execute_sql", {
            sql: "SELECT date, close FROM prices",
          }),
          llmEmitsText(`Below is the CSV.\n\n\`\`\`\n${csv}\n\`\`\``),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        promptSuggestionsEnabled: false,
        conversationId: "stream-sql-export-artifact",
      }),
    );

    const sqlStatus = events.find(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { message?: string }).message === "execute_sql returned a result",
    );
    expect(sqlStatus).toBeUndefined();

    expect(events.find((e) => e.event === "copilotMessageArtifact")).toBeUndefined();

    const messageText = events
      .filter((e) => e.event === "copilotMessageChunk")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    expect(messageText).toContain("Below is the CSV.");
    expect(messageText).toContain("date,close");
  });

  it("can place answer artifacts between final text paragraphs", async () => {
    rememberRows("stream-artifact-middle", "prices", [
      { symbol: "NVDA", close: 100 },
      { symbol: "AAPL", close: 200 },
    ]);

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "chart prices" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("create_artifact", {
            display_summary: "Rendering the prices table",
            sql: "SELECT * FROM prices",
            artifact: { type: "table", name: "Prices", description: "loaded prices" },
          }),
          llmEmitsText("Here is the prices table.\n\nTop close is 200."),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        promptSuggestionsEnabled: false,
        conversationId: "stream-artifact-middle",
      }),
    );

    const leadTextIdx = events.findIndex(
      (e) =>
        e.event === "copilotMessageChunk" &&
        (e.data as { delta: string }).delta === "Here is the prices table.\n\n",
    );
    const artifactEventIdx = events.findIndex((e) => e.event === "copilotMessageArtifact");
    const followTextIdx = events.findIndex(
      (e) =>
        e.event === "copilotMessageChunk" &&
        (e.data as { delta: string }).delta === "Top close is 200.",
    );

    expect(leadTextIdx).toBeGreaterThanOrEqual(0);
    expect(artifactEventIdx).toBeGreaterThan(leadTextIdx);
    expect(followTextIdx).toBeGreaterThan(artifactEventIdx);
  });

  it("preserves final text when a table artifact is rendered", async () => {
    rememberRows("stream-artifact-inline-table", "metrics", [
      { metric: "Renewable Energy %", value_2020: 12.3, value_2024: 33.7, pct_change: 174 },
      { metric: "Waste Recycled %", value_2020: 38, value_2024: 51.9, pct_change: 36.7 },
    ]);

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "Show a table of ESG metrics that improved most" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("create_artifact", {
            display_summary: "Rendering ESG improvements",
            sql: "SELECT * FROM metrics",
            artifact: { type: "table", name: "ESG Metric Improvements", description: "loaded metrics" },
          }),
          llmEmitsText(
            "**ESG metrics that improved most**\n\n" +
              "| Metric | 2020 Value | 2024 Value | % Change |\n" +
              "|--------|------------|------------|----------|\n" +
              "| Renewable Energy % | 12.3% | 33.7% | +174% |\n" +
              "| Waste Recycled % | 38% | 51.9% | +36.7% |\n\n" +
              "**Key takeaways**\n\nRenewable energy improved most.",
          ),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        promptSuggestionsEnabled: false,
        conversationId: "stream-artifact-inline-table",
      }),
    );

    const artifact = events.find((e) => e.event === "copilotMessageArtifact")?.data as
      | { type?: string; name?: string }
      | undefined;
    expect(artifact).toMatchObject({
      type: "table",
      name: "ESG Metric Improvements",
    });
    const messageText = events
      .filter((e) => e.event === "copilotMessageChunk")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    expect(messageText).toContain("**ESG metrics that improved most**");
    expect(messageText).toContain("**Key takeaways**");
    expect(messageText).toContain("Renewable energy improved most.");
    expect(messageText).toContain("| Metric |");
    expect(messageText).toContain("| Renewable Energy % |");
  });

  it("preserves final text when the table artifact is attached to tool progress", async () => {
    rememberRows("stream-artifact-status-table", "metrics", [
      { metric: "Renewable Energy %", value_2020: 12.3, value_2024: 33.7, pct_change: 174 },
      { metric: "Waste Recycled %", value_2020: 38, value_2024: 51.9, pct_change: 36.7 },
    ]);

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "Which ESG metrics improved most?" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("create_artifact", {
            display_summary: "Rendering ESG improvements",
            sql: "SELECT * FROM metrics",
            artifact: { type: "table", name: "ESG Metric Improvements", description: "loaded metrics" },
          }),
          llmEmitsText(
            "**ESG metrics that improved most**\n\n" +
              "| Metric | 2020 Value | 2024 Value | % Change |\n" +
              "|--------|------------|------------|----------|\n" +
              "| Renewable Energy % | 12.3% | 33.7% | +174% |\n" +
              "| Waste Recycled % | 38% | 51.9% | +36.7% |\n\n" +
              "**Key takeaways**\n\nRenewable energy improved most.",
          ),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        promptSuggestionsEnabled: false,
        conversationId: "stream-artifact-status-table",
      }),
    );

    const statusArtifact = events
      .filter((e) => e.event === "copilotStatusUpdate")
      .flatMap((e) => ((e.data as { artifacts?: unknown[] }).artifacts ?? []))[0] as
      | { type?: string; name?: string }
      | undefined;
    expect(statusArtifact).toMatchObject({
      type: "table",
      name: "ESG Metric Improvements",
    });
    const messageText = events
      .filter((e) => e.event === "copilotMessageChunk")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    expect(messageText).toContain("**ESG metrics that improved most**");
    expect(messageText).toContain("**Key takeaways**");
    expect(messageText).toContain("Renewable energy improved most.");
    expect(messageText).toContain("| Metric |");
    expect(messageText).toContain("| Renewable Energy % |");
  });

  it("emits comparison chart artifacts and strips inline chart placeholders", async () => {
    rememberRows("stream-artifact-compare", "prices", [
      { symbol: "NVDA", close: 100 },
      { symbol: "AAPL", close: 200 },
    ]);

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "compare prices" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("create_artifact", {
            display_summary: "Rendering the comparison chart",
            sql: "SELECT * FROM prices",
            artifact: {
              type: "chart",
              name: "Price Comparison",
              description: "loaded prices",
              chartType: "bar",
              xKey: "symbol",
              yKey: ["close"],
            },
          }),
          llmEmitsText('Visual Summary\n\n<chart artifact="Price Comparison"/>'),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        promptSuggestionsEnabled: false,
        conversationId: "stream-artifact-compare",
      }),
    );

    const artifact = events.find((e) => e.event === "copilotMessageArtifact")?.data as
      | { type?: string; name?: string }
      | undefined;
    expect(artifact).toMatchObject({
      type: "chart",
      name: "Price Comparison",
    });
    const messageText = events
      .filter((e) => e.event === "copilotMessageChunk")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    expect(messageText).toContain("Visual Summary");
    expect(messageText).not.toContain("<chart");
  });

  it("emits create_artifact output consistently regardless of user wording", async () => {
    rememberRows("stream-artifact-reasoning-only", "prices", [
      { symbol: "NVDA", close: 100 },
      { symbol: "AAPL", close: 200 },
    ]);

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "summarize prices" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("create_artifact", {
            display_summary: "Rendering supporting table",
            sql: "SELECT * FROM prices",
            artifact: { type: "table", name: "Prices", description: "loaded prices" },
          }),
          llmEmitsText("AAPL has the higher close."),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        promptSuggestionsEnabled: false,
        conversationId: "stream-artifact-reasoning-only",
      }),
    );

    const artifactStatus = events.find(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { message?: string }).message === 'Rendered table artifact "Prices" from 2 rows.',
    );
    expect((artifactStatus?.data as { artifacts?: unknown[] } | undefined)?.artifacts).toHaveLength(1);
    expect(events.some((e) => e.event === "copilotMessageArtifact")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.event === "copilotMessageChunk" &&
          (e.data as { delta?: string }).delta?.includes("AAPL has the higher close"),
      ),
    ).toBe(true);
  });

  it("streams assistant prose emitted before tool calls (no longer suppressed)", async () => {
    rememberRows("stream-progress-text", "prices", [
      { symbol: "NVDA", close: 100 },
      { symbol: "AAPL", close: 200 },
    ]);

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "summarize prices" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsToolWithText(
            "execute_sql",
            {
              display_summary: "Checking the top close",
              sql: "SELECT MAX(close) AS m FROM prices",
            },
            "I'll inspect the prices first.",
          ),
          llmEmitsText("Top close is 200."),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "stream-progress-text",
      }),
    );

    // Decision: pre-tool prose now streams live instead of being suppressed.
    // Intent belongs in _llm_think / display_summary (the prompt nudges toward
    // that), but free prose, if emitted, is shown rather than silently dropped —
    // mid-stream rerouting of preamble is impossible (the lookahead wall).
    const messageText = events
      .filter((e) => e.event === "copilotMessageChunk")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    expect(messageText).toContain("I'll inspect the prices first.");
    expect(messageText).toContain("Top close is 200.");
  });

  it("surfaces invalid in-process tool inputs as warnings", async () => {
    rememberRows("stream-invalid-tool", "prices", [
      { symbol: "NVDA", close: 100 },
      { symbol: "AAPL", close: 200 },
    ]);

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "chart prices" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("create_artifact", {
            sql: "SELECT * FROM prices",
            artifact: { type: "line", xKey: "symbol", yKey: "close" },
          }),
          llmEmitsText("done"),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "stream-invalid-tool",
      }),
    );

    const warning = events.find(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { eventType?: string; message?: string }).eventType === "WARNING" &&
        (e.data as { message?: string }).message === "Input rejected",
    );
    expect(warning).toBeDefined();
    expect(
      events.find(
        (e) =>
          e.event === "copilotStatusUpdate" &&
          (e.data as { message?: string }).message?.startsWith("Rendering"),
      ),
    ).toBeUndefined();
  });

  it("emits _llm_think summaries with the plan in planning details", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "show renewable trend" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("_llm_think", {
            summary: "Fetching 5-year renewable energy trend.",
            plan: "1. Load the energy widget.\n2. Create the chart.",
          }),
          llmEmitsText("Done."),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "stream-llm-think",
      }),
    );

    const planning = events.find(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { group?: string; message?: string }).group === "planning" &&
        (e.data as { message?: string }).message === "Fetching 5-year renewable energy trend.",
    );
    expect(planning).toBeDefined();
    expect((planning!.data as { details?: string[] }).details).toEqual([
      "1. Load the energy widget.\n2. Create the chart.",
    ]);
    expect(
      events.find(
        (e) =>
          e.event === "copilotStatusUpdate" &&
          ((e.data as { message?: string }).message ?? "").startsWith("_llm_think"),
      ),
    ).toBeUndefined();
  });

  it("does not warn when a tool-only stop already emitted an answer artifact", async () => {
    rememberRows("stream-artifact-only", "prices", [
      { symbol: "NVDA", close: 100 },
      { symbol: "AAPL", close: 200 },
    ]);

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "chart prices" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("create_artifact", {
            sql: "SELECT * FROM prices",
            artifact: { type: "table", name: "Prices", description: "loaded prices" },
          }),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        promptSuggestionsEnabled: false,
        conversationId: "stream-artifact-only",
      }),
    );

    expect(events.some((e) => e.event === "copilotMessageArtifact")).toBe(true);
    expect(
      events.find(
        (e) =>
          e.event === "copilotStatusUpdate" &&
          (e.data as { message?: string }).message ===
            "Model stopped after tool output without a follow-up action.",
      ),
    ).toBeUndefined();
  });

  it("warns when the model stops after an in-process tool without answering", async () => {
    const widget: Widget = {
      uuid: "energy",
      origin: "Teixeira Duarte",
      widget_id: "energy_vs_revenue",
      name: "Energy Consumption, Renewables and Revenue",
      description: "Renewable energy share trend",
      params: [],
    };

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "show renewable trend" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("search_widgets", {
            query: "renewable",
          }),
        ]),
        allWidgets: [widget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "stream-stopped-after-search",
      }),
    );

    const warning = events.find(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { eventType?: string; message?: string }).eventType === "WARNING" &&
        (e.data as { message?: string }).message ===
          "Model stopped after tool output without a follow-up action.",
    );
    expect(warning).toBeDefined();
    expect((warning!.data as { details?: Array<Record<string, unknown>> }).details).toEqual([
      { tool_calls: ["search_widgets"] },
    ]);
    expect(
      events.find(
        (e) =>
          e.event === "copilotMessageChunk" &&
          (e.data as { delta?: string }).delta?.includes("`search_widgets`"),
      ),
    ).toBeDefined();
  });

  it("keeps widget search available after a schema round-trip when fetching data", async () => {
    const fred: Widget = {
      uuid: "economy_fred_series_fred_obb",
      origin: "Open Data Platform",
      widget_id: "economy_fred_series_fred_obb",
      name: "Fred Series",
      description: "Get data by series ID from FRED.",
      params: [
        { name: "symbol", type: "text", description: "", default_value: null },
        { name: "frequency", type: "text", description: "", default_value: null },
      ],
    };
    const priorSchema: ToolMessage = {
      role: "tool",
      function: "get_widget_schema",
      input_arguments: {
        origin: "Open Data Platform",
        widget_id: "economy_fred_series_fred_obb",
      },
      data: [
        {
          status: "success",
          message: "Widget schema loaded.",
          data: {
            ok: true,
            command: "get_widget_schema",
            data: {
              widget: {
                origin: "Open Data Platform",
                widget_id: "economy_fred_series_fred_obb",
                name: "Fred Series",
                params: [
                  { paramName: "symbol", type: "text", show: true, value: null, options: [] },
                  {
                    paramName: "frequency",
                    type: "text",
                    show: true,
                    value: null,
                    options: [{ label: "m", value: "m" }],
                  },
                ],
              },
            },
          },
        },
      ] as unknown as ToolMessage["data"],
    };

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "Export the widget data to CSV" },
            priorSchema,
          ],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("search_widgets", { query: "FRED" }),
          llmCallsTool("get_widget_data", {
            widgets: [
              {
                widget_uuid: "economy_fred_series_fred_obb",
                input_args: { symbol: "UNRATE", frequency: "m" },
              },
            ],
          }),
        ]),
        allWidgets: [fred],
        tieredWidgets: [{ widget: fred, tier: "extra" }],
        workspaceState: null,
        generativeUiEnabled: true,
        promptSuggestionsEnabled: false,
        conversationId: "stream-schema-no-rediscovery",
      }),
    );

    const statusMessages = events
      .filter((e) => e.event === "copilotStatusUpdate")
      .map((e) => (e.data as { message?: string }).message ?? "");
    expect(statusMessages.some((message) => message === 'Searching widgets for "FRED"'))
      .toBe(true);
    expect(statusMessages.some((message) => message.startsWith("Found "))).toBe(true);
    expect(
      events.find(
        (e) =>
          e.event === "copilotFunctionCall" &&
          (e.data as { function?: string }).function === "get_widget_data",
      ),
    ).toBeDefined();
  });

  it("allows additional widget search after schema when the request asks for multiple widgets", async () => {
    const board: Widget = {
      uuid: "board_structure",
      origin: "Teixeira Duarte",
      widget_id: "board_structure",
      name: "Board Size, Independence and Gender Mix",
      description: "Governance view comparing board member count and independence.",
      params: [],
    };
    const compliance: Widget = {
      uuid: "ethics_compliance",
      origin: "Teixeira Duarte",
      widget_id: "ethics_compliance",
      name: "Compliance Cases, Resolution Rate and Timing",
      description: "Governance view tracking compliance cases and resolution rates.",
      params: [],
    };
    const priorSchema: ToolMessage = {
      role: "tool",
      function: "get_widget_schema",
      input_arguments: {
        origin: "Teixeira Duarte",
        widget_id: "board_structure",
      },
      data: [
        {
          status: "success",
          message: "Widget schema loaded.",
          data: {
            ok: true,
            command: "get_widget_schema",
            data: {
              widget: {
                origin: "Teixeira Duarte",
                widget_id: "board_structure",
                name: "Board Size, Independence and Gender Mix",
                params: [],
              },
            },
          },
        },
      ] as unknown as ToolMessage["data"],
    };

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "Create a dashboard with 2 governance widgets" },
            priorSchema,
          ],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("search_widgets", { query: "Governance" }),
          llmEmitsText("Found another governance widget."),
        ]),
        allWidgets: [board, compliance],
        tieredWidgets: [
          { widget: board, tier: "extra" },
          { widget: compliance, tier: "extra" },
        ],
        workspaceState: null,
        generativeUiEnabled: true,
        promptSuggestionsEnabled: false,
        conversationId: "stream-schema-allow-second-widget-search",
      }),
    );

    const statusMessages = events
      .filter((e) => e.event === "copilotStatusUpdate")
      .map((e) => (e.data as { message?: string }).message ?? "");

    expect(statusMessages.some((message) => message === 'Searching widgets for "Governance"'))
      .toBe(true);
    expect(statusMessages.some((message) => message.startsWith("Found "))).toBe(true);
  });

  it("warns when a later empty step follows a completed tool and suppresses naked citations", async () => {
    rememberRows("stream-empty-after-tool", "prices", [
      { symbol: "NVDA", close: 100 },
      { symbol: "AAPL", close: 200 },
    ]);

    const citation: Citation = {
      id: "source-1",
      source_info: { type: "web", name: "Source", citable: true },
      details: [{ link: "https://example.com" }],
      signature: "sig",
    };
    const priorTool: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: { tool_name: "fetch_webpage", server_id: "rita" },
      data: [{ items: [{ text: "" }] }],
      extra_state: { intermediate_citations: [citation] },
    };

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "chart prices" }, priorTool],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("execute_sql", { sql: "SELECT * FROM prices" }),
          { finishReason: "stop" },
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        promptSuggestionsEnabled: false,
        conversationId: "stream-empty-after-tool",
      }),
    );

    const warning = events.find(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { eventType?: string; message?: string }).eventType === "WARNING" &&
        (e.data as { message?: string }).message ===
          "Model stopped after tool output without a follow-up action.",
    );
    expect(warning).toBeDefined();
    expect((warning!.data as { details?: Array<Record<string, unknown>> }).details).toEqual([
      { tool_calls: ["execute_sql"] },
    ]);
    expect(
      events.find(
        (e) =>
          e.event === "copilotMessageChunk" &&
          (e.data as { delta?: string }).delta?.includes("`execute_sql`"),
      ),
    ).toBeDefined();
    expect(events.find((e) => e.event === "copilotCitationCollection")).toBeUndefined();
  });
});

import { describe, it, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { injectFromReboot, injectWidgetData, type RoundTripContext } from "../../../../src/agent/round-trip";
import type {
  Citation,
  SSEEvent,
  ToolMessage,
  Widget,
} from "../../../../src/protocol/types";
import type { McpCitation } from "../../../../src/mcp/results";
import type { WidgetItem } from "../../../../src/widgets/parse";

function emptyCtx(): RoundTripContext {
  return {
    tables: [],
    messages: [] as ModelMessage[],
    allWidgets: [] as Widget[],
    citedWidgets: new Map(),
    mcpCitations: [] as McpCitation[],
    artifactQueue: [] as SSEEvent[],
    intermediateCitations: [] as Citation[],
    pendingTables: new Map(),
    tablesShipped: new Set<string>(),
    conversationId: "test",
  };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe("injectWidgetData — same widget, different params", () => {
  function priceItem(symbol: string, close: number): WidgetItem {
    return {
      name: "Historical Stock Price",
      uuid: "hsp",
      content: JSON.stringify([{ date: "2024-05-28", close }]),
      inputArgs: { symbol },
    };
  }

  it("keeps each param's dataset queryable instead of clobbering one table", () => {
    const ctx = emptyCtx();
    injectWidgetData(
      [priceItem("AAPL", 189.99), priceItem("MSFT", 430.32), priceItem("NVDA", 113.9)],
      ctx,
    );
    // Three pulls of the same widget with different symbols must not collapse
    // into one table — each dataset stays independently queryable.
    expect(ctx.pendingTables.size).toBe(3);
    const closes = [...ctx.pendingTables.values()]
      .flat()
      .map((row) => (row as { close: number }).close);
    expect(closes).toContain(189.99);
    expect(closes).toContain(430.32);
    expect(closes).toContain(113.9);
  });

  it("reuses one table when the same widget is loaded with identical params", () => {
    const ctx = emptyCtx();
    injectWidgetData([priceItem("AAPL", 189.99), priceItem("AAPL", 190.5)], ctx);
    // Same (widget, params) is a refresh, not a distinct dataset.
    expect(ctx.pendingTables.size).toBe(1);
  });
});

describe("injectFromReboot — get_params_options", () => {
  it("injects the resolved options payload as a user message", async () => {
    const tool: ToolMessage = {
      role: "tool",
      function: "get_params_options",
      input_arguments: {
        param_options_queries: [
          { origin: "openbb", widget_id: "stocks", param_name: "ticker" },
        ],
      },
      data: [
        {
          items: [{ content: "" }],
        },
      ] as unknown as ToolMessage["data"],
    };
    // workspace shape varies; stuff a sample payload on `data` for the test
    (tool.data as unknown as Array<unknown>)[0] = {
      origin: "openbb",
      widget_id: "stocks",
      param_name: "ticker",
      options: ["AAPL", "MSFT", "GOOG"],
    };
    const ctx = emptyCtx();
    const events = await drain(injectFromReboot(tool, ctx));
    expect(ctx.messages).toHaveLength(1);
    const msg = ctx.messages[0];
    expect(msg.role).toBe("user");
    const content = msg.content as string;
    expect(content).toContain("Workspace bridge result from get_params_options");
    expect(content).toContain("AAPL");
    expect(content).toContain("MSFT");
    expect(events.length).toBe(1);
    expect(events[0].event).toBe("copilotStatusUpdate");
    expect(events[0].data.message).toBe("Parameter options resolved");
  });
});

describe("injectFromReboot — MCP results", () => {
  it("labels artifact-producing MCP output with the provider/tool name without leaking opaque server ids", async () => {
    const artifact = {
      type: "table" as const,
      uuid: "artifact-1",
      name: "Search Results",
      description: "Search result rows",
      content: [{ title: "Reddit thread", url: "https://reddit.com/r/apple/example" }],
    };
    const tool: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: {
        server_id: "1780344528097",
        tool_name: "LinqAlpha_web_search",
        parameters: { query: "MacBook Neo reddit reaction site:reddit.com" },
      },
      data: [
        {
          items: [
            { content: JSON.stringify({ $rita_kind: "artifact", artifact }) },
            { content: "Search result text." },
          ],
        },
      ],
    };
    const events = await drain(injectFromReboot(tool, emptyCtx()));

    expect(events).toHaveLength(1);
    expect(events[0].data.message).toBe("Output from LinqAlpha - web_search");
    expect(events[0].data.details).toBeUndefined();
    expect(events[0].data.artifacts).toEqual([artifact]);
    expect(JSON.stringify(events[0].data)).not.toContain("output_summary");
    expect(JSON.stringify(events[0].data)).not.toContain("input_params");
    expect(JSON.stringify(events[0].data)).not.toContain("serverId");
    expect(JSON.stringify(events[0].data)).not.toContain("1780344528097");
  });

  it("emits text-only MCP result rows so the user can see the tool output", async () => {
    const ctx = emptyCtx();
    const tool: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: {
        server_id: "1780344528097",
        tool_name: "LinqAlpha_cite_web_source",
        parameters: { url: "https://reddit.com/r/apple/example" },
      },
      data: [
        {
          items: [
            {
              content: JSON.stringify({
                $rita_kind: "citation",
                citation: {
                  type: "web",
                  url: "https://reddit.com/r/apple/example",
                  title: "MacBook Neo launch reaction thread",
                },
              }),
            },
            { content: "Citation saved." },
          ],
        },
      ],
    };

    const events = await drain(injectFromReboot(tool, ctx));

    expect(events).toHaveLength(1);
    expect(events[0].data.message).toBe("LinqAlpha - cite_web_source completed");
    expect(events[0].data.details).toEqual(["Citation saved."]);
    expect(events[0].data.artifacts).toBeUndefined();
    expect(JSON.stringify(events[0].data)).not.toContain("output_summary");
    expect(JSON.stringify(events[0].data)).not.toContain("textChars");
    expect(ctx.mcpCitations).toEqual([
      expect.objectContaining({
        type: "web",
        title: "MacBook Neo launch reaction thread",
      }),
    ]);
    expect(ctx.messages).toHaveLength(1);
  });

  it("labels typed MCP errors as warnings instead of completed results", async () => {
    const ctx = emptyCtx();
    const tool: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: {
        server_id: "OpenBB MCP",
        tool_name: "mermaid_diagram",
        parameters: { code: "flowchart TD\nE[Open Data Platform (ODP)]" },
      },
      data: [
        {
          items: [
            {
              content: JSON.stringify({
                $rita_kind: "error",
                error: {
                  code: "MERMAID_SYNTAX",
                  message: "Mermaid syntax error: Parse error on line 2",
                  retryable: true,
                },
              }),
            },
          ],
        },
      ],
    };

    const events = await drain(injectFromReboot(tool, ctx));

    expect(events).toHaveLength(1);
    expect(events[0].data.eventType).toBe("WARNING");
    expect(events[0].data.message).toBe("OpenBB MCP - mermaid_diagram returned an error");
    expect(events[0].data.details).toEqual([
      "[ERROR MERMAID_SYNTAX retryable] Mermaid syntax error: Parse error on line 2",
    ]);
    expect(events[0].data.artifacts).toBeUndefined();
  });

  it("renders JSON MCP output as a table artifact instead of raw JSON details", async () => {
    const tool: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: {
        server_id: "1780344528097",
        tool_name: "LinqAlpha_web_search",
        parameters: { query: "MacBook Neo Reddit comments review sentiment" },
      },
      data: [
        {
          items: [
            {
              content: JSON.stringify({
                success: true,
                query: "MacBook Neo Reddit comments review sentiment",
                answer: "Mixed reviews; praised for performance but criticized for price.",
                result_count: 2,
                results: [
                  {
                    title: "MacBook Neo Reddit Review: What Real Users Think",
                    url: "https://example.com/review",
                    content: "Positive feedback centers on performance and battery life.",
                    score: 0.85,
                    source_domain: "example.com",
                  },
                  {
                    title: "Macbook Neo Impressions: Reincarnated! - MKBHD : r/apple - Reddit",
                    url: "https://www.reddit.com/r/apple/comments/example",
                    content: "The new $599 Macbook is a good deal.",
                    score: 0.69,
                    source_domain: "reddit.com",
                  },
                ],
              }),
            },
          ],
        },
      ],
    };

    const events = await drain(injectFromReboot(tool, emptyCtx()));

    expect(events).toHaveLength(1);
    expect(events[0].data.message).toBe("LinqAlpha - web_search completed");
    expect(events[0].data.details).toBeUndefined();
    const searchArtifacts = events[0].data.artifacts as Array<Record<string, unknown>>;
    expect(searchArtifacts[0]).toMatchObject({
      type: "table",
      name: "LinqAlpha - web_search Output",
      content: [
        expect.objectContaining({
          title: "MacBook Neo Reddit Review: What Real Users Think",
          source_domain: "example.com",
        }),
        expect.objectContaining({
          title: "Macbook Neo Impressions: Reincarnated! - MKBHD : r/apple - Reddit",
          source_domain: "reddit.com",
        }),
      ],
    });
    expect(JSON.stringify(events[0].data)).not.toContain('"results"');
    expect(JSON.stringify(events[0].data)).not.toContain("1780344528097");
  });

  it("renders single-object JSON MCP output as a one-row table artifact", async () => {
    const tool: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: {
        server_id: "1780344528097",
        tool_name: "LinqAlpha_cite_web_source",
        parameters: { url: "https://www.reddit.com/r/mac/comments/example" },
      },
      data: [
        {
          items: [
            {
              content: JSON.stringify({
                success: true,
                citation_idx: 4,
                reference_id: "9feabb49-7efa-4660-8dd2-fc721f143759",
                message: "Web reference created with citation index [4]",
                title: "MacBook neo first impressions : r/mac - Reddit",
                url: "https://www.reddit.com/r/mac/comments/example",
              }),
            },
          ],
        },
      ],
    };

    const events = await drain(injectFromReboot(tool, emptyCtx()));

    expect(events).toHaveLength(1);
    expect(events[0].data.message).toBe("LinqAlpha - cite_web_source completed");
    expect(events[0].data.details).toBeUndefined();
    const citationArtifacts = events[0].data.artifacts as Array<Record<string, unknown>>;
    expect(citationArtifacts[0]).toMatchObject({
      type: "table",
      name: "LinqAlpha - cite_web_source Output",
      content: [
        expect.objectContaining({
          success: true,
          citation_idx: 4,
          title: "MacBook neo first impressions : r/mac - Reddit",
        }),
      ],
    });
    expect(JSON.stringify(events[0].data)).not.toContain("1780344528097");
  });
});

describe("injectFromReboot — workspace bridge results", () => {
  it("emits get_workspace_snapshot results as structured workspace details", async () => {
    const tool: ToolMessage = {
      role: "tool",
      function: "get_workspace_snapshot",
      input_arguments: {},
      data: [
        {
          status: "success",
          message: "Workspace snapshot loaded.",
          data: {
            ok: true,
            command: "get_workspace_snapshot",
            data: {
              generated_at: 1_700_000_000,
              workspace_state: {
                current_dashboard_uuid: "dash-1",
                current_dashboard_info: {
                  id: "dash-1",
                  name: "Macro Dashboard",
                  current_tab_id: "macro",
                  tabs: [
                    {
                      tab_id: "macro",
                      name: "Macro",
                      widgets: [{ name: "Rates" }, { name: "Jobs" }],
                    },
                    {
                      tab_id: "companies",
                      name: "Companies",
                      widgets: [{ name: "Earnings" }],
                    },
                  ],
                },
              },
              dashboards: [
                { id: "dash-1", name: "Macro Dashboard" },
                { id: "dash-2", name: "ESG Dashboard" },
              ],
              widgets: {
                primary: [{ name: "Pinned" }],
                secondary: [{ name: "Visible" }, { name: "Also Visible" }],
                extra: [{ name: "Connected" }],
              },
              skills: [{ slug: "summarize-table" }],
              tools: [{ name: "browser.search" }],
              files: [{ name: "macro.pdf" }],
              artifacts: [{ name: "UNRATE Export" }],
              context: [{ name: "context" }],
              session_context: {
                current_dashboard_uuid: "dash-1",
                current_tab_id: "macro",
              },
            },
          },
        },
      ] as unknown as ToolMessage["data"],
    };
    const ctx = emptyCtx();

    const events = await drain(injectFromReboot(tool, ctx));

    expect(ctx.messages).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].data.message).toBe("Workspace snapshot loaded");
    expect(events[0].data.details).toEqual([
      {
        Dashboards: {
          "Macro Dashboard": {
            "Macro (current)": ["Rates", "Jobs"],
            Companies: ["Earnings"],
          },
          "ESG Dashboard": {},
        },
        Skills: ["summarize-table"],
        Tools: ["browser.search"],
        Files: ["macro.pdf"],
        Artifacts: ["UNRATE Export"],
      },
    ]);
  });

  it("injects list_available_widgets results so the model can continue", async () => {
    const tool: ToolMessage = {
      role: "tool",
      function: "list_available_widgets",
      input_arguments: { origin: "Open Data Platform" },
      data: [
        {
          status: "success",
          message: "Available widgets listed.",
          data: {
            ok: true,
            command: "list_available_widgets",
            data: {
              widgets: [
                {
                  origin: "Open Data Platform",
                  backend_name: "Open Data Platform",
                  widget_id: "economy_fred_series_fred_obb",
                  name: "Fred Series",
                  description: "Get data by series ID from FRED.",
                },
              ],
            },
          },
        },
      ] as unknown as ToolMessage["data"],
    };
    const ctx = emptyCtx();

    const events = await drain(injectFromReboot(tool, ctx));

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].role).toBe("user");
    const content = ctx.messages[0].content as string;
    expect(content).toContain("Workspace bridge result from list_available_widgets");
    expect(content).toContain("economy_fred_series_fred_obb");
    expect(content).not.toContain("config.data_args");
    expect(events).toHaveLength(1);
    expect(events[0].data.message).toBe("Available widgets listed");
    expect(events[0].data.details).toBeUndefined();
    expect((events[0].data as { artifacts?: unknown[] }).artifacts?.[0]).toMatchObject({
      type: "table",
      name: "Available Widgets",
      content: [
        {
          backend_name: "Open Data Platform",
          widget_name: "Fred Series",
          description: "Get data by series ID from FRED.",
        },
      ],
    });
  });

  it("forwards empty list_available_widgets results without recovery hints", async () => {
    const tool: ToolMessage = {
      role: "tool",
      function: "list_available_widgets",
      input_arguments: { origin: "ESG" },
      data: [
        {
          status: "success",
          message: "Available widgets listed.",
          data: {
            ok: true,
            command: "list_available_widgets",
            data: {
              widgets: [],
            },
          },
        },
      ] as unknown as ToolMessage["data"],
    };
    const ctx = emptyCtx();

    const events = await drain(injectFromReboot(tool, ctx));

    expect(ctx.messages).toHaveLength(1);
    const content = ctx.messages[0].content as string;
    expect(content).toContain("Workspace bridge result from list_available_widgets");
    expect(content).toContain('"origin": "ESG"');
    expect(content).not.toContain("retry discovery without the origin filter");
    expect(events).toHaveLength(1);
    expect(events[0].data.message).toBe("Available widgets listed");
    expect(events[0].data.details).toBeUndefined();
    expect((events[0].data as { artifacts?: unknown[] }).artifacts).toBeUndefined();
  });

  it("emits get_widget_schema results as an input schema artifact", async () => {
    const tool: ToolMessage = {
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
                backend_name: "Open Data Platform",
                widget_id: "economy_fred_series_fred_obb",
                name: "Fred Series",
                description: "Get data by series ID from FRED.",
                params: [
                  {
                    paramName: "symbol",
                    label: "Symbol",
                    value: null,
                    description: "Symbol to get data for.",
                    multiple: true,
                    type: "text",
                    show: true,
                    options: [],
                  },
                  {
                    paramName: "frequency",
                    label: "Frequency",
                    value: null,
                    description: "Frequency aggregation.",
                    multiple: false,
                    type: "text",
                    show: true,
                    options: [
                      { label: "a", value: "a" },
                      { label: "m", value: "m" },
                    ],
                  },
                  {
                    paramName: "provider",
                    label: "provider",
                    value: "fred",
                    multiple: false,
                    type: "text",
                    show: false,
                    options: [],
                  },
                ],
              },
            },
          },
        },
      ] as unknown as ToolMessage["data"],
    };
    const ctx = emptyCtx();

    const events = await drain(injectFromReboot(tool, ctx));

    expect(ctx.messages).toHaveLength(1);
    const content = ctx.messages[0].content as string;
    expect(content).toContain("Workspace bridge result from get_widget_schema");
    expect(content).toContain('"widget_id": "economy_fred_series_fred_obb"');
    expect(content).not.toContain("Do not call search_widgets or get_workspace_snapshot");
    expect(content).toContain('"value": "m"');
    expect(content).toContain('"show": false');
    expect(content).not.toContain("fixed provider default");
    expect(events).toHaveLength(1);
    expect(events[0].data.message).toBe("Widget schema loaded");
    expect(events[0].data.details).toBeUndefined();
    expect((events[0].data as { artifacts?: unknown[] }).artifacts?.[0]).toMatchObject({
      type: "table",
      name: "Fred Series Schema",
      description: "Input schema for Fred Series",
      content: [
        {
          input: "symbol",
          label: "Symbol",
          type: "text",
          default_value: null,
          multiple: true,
          visible: true,
          options: null,
          description: "Symbol to get data for.",
        },
        {
          input: "frequency",
          label: "Frequency",
          type: "text",
          default_value: null,
          multiple: false,
          visible: true,
          options: "a, m",
          description: "Frequency aggregation.",
        },
        {
          input: "provider",
          label: "provider",
          type: "text",
          default_value: "fred",
          multiple: false,
          visible: false,
          options: null,
          description: null,
        },
      ],
    });
  });

  it("does not repeat create_widget details on the result status", async () => {
    const tool: ToolMessage = {
      role: "tool",
      function: "add_widget_to_dashboard",
      input_arguments: {
        origin: "Open Data Platform",
        widget_id: "economy_fred_series_fred_obb",
        config: {
          data_args: {
            provider: "fred",
            symbol: "UNRATE",
          },
          ui_args: {},
        },
      },
      data: [
        {
          status: "success",
          message: "Widget created.",
          data: {
            ok: true,
            command: "add_widget_to_dashboard",
            data: {
              widget_uuid: "widget-1",
            },
          },
        },
      ] as unknown as ToolMessage["data"],
    };
    const ctx = emptyCtx();

    const events = await drain(injectFromReboot(tool, ctx));

    expect(events).toHaveLength(1);
    expect(events[0].data.message).toBe("Widget creation result received");
    expect(events[0].data.details).toBeUndefined();
    expect(ctx.messages[0].content).toContain("Workspace bridge result from add_widget_to_dashboard");
    expect(ctx.messages[0].content).toContain('"widget_uuid": "widget-1"');
    expect(ctx.messages[0].content).not.toContain("do not mention widget_uuid");
  });

  it("does not repeat successful manage_dashboard details on the result status", async () => {
    const tool: ToolMessage = {
      role: "tool",
      function: "manage_dashboard",
      input_arguments: {
        operation: "create",
        name: "ESG Governance Dashboard",
      },
      data: [
        {
          status: "success",
          message: "Dashboard created.",
          data: {
            ok: true,
            command: "manage_dashboard",
            message: "Dashboard created.",
            data: {
              dashboard_id: "dashboard-1",
              name: "ESG Governance Dashboard",
            },
          },
        },
      ] as unknown as ToolMessage["data"],
    };
    const ctx = emptyCtx();

    const events = await drain(injectFromReboot(tool, ctx));

    expect(events).toHaveLength(1);
    expect(events[0].data.message).toBe("Dashboard created");
    expect(events[0].data.details).toBeUndefined();
    expect(ctx.messages[0].content).toContain("Workspace bridge result from manage_dashboard");
    expect(ctx.messages[0].content).toContain('"dashboard_id": "dashboard-1"');
    expect(ctx.messages[0].content).not.toContain("Do not call manage_dashboard again");
  });

  it("emits concise manage_navigation_bar result statuses", async () => {
    const successTool: ToolMessage = {
      role: "tool",
      function: "manage_navigation_bar",
      input_arguments: {
        operation: "create",
        tabs: [{ name: "Governance" }, { name: "Social" }],
      },
      data: [
        {
          status: "success",
          message: "Navigation bar created with tabs: Governance, Social",
        },
      ] as unknown as ToolMessage["data"],
    };
    const errorTool: ToolMessage = {
      role: "tool",
      function: "manage_navigation_bar",
      input_arguments: {
        operation: "add_tabs",
        tabs: [{ name: "Governance" }, { name: "Social" }],
      },
      data: [
        {
          status: "error",
          message: "No navigation bar found. Use 'create' to create one first.",
        },
      ] as unknown as ToolMessage["data"],
    };

    const successEvents = await drain(injectFromReboot(successTool, emptyCtx()));
    expect(successEvents[0].data.message).toBe("Navigation bar created with tabs: Governance, Social");
    expect(successEvents[0].data.details).toBeUndefined();

    const errorEvents = await drain(injectFromReboot(errorTool, emptyCtx()));
    expect(errorEvents[0].data.message).toBe("Navigation update failed");
    expect(errorEvents[0].data.details).toEqual([
      "No navigation bar found. Use 'create' to create one first.",
    ]);
    const errorCtx = emptyCtx();
    await drain(injectFromReboot(errorTool, errorCtx));
    expect(errorCtx.messages[0].content).toContain("Workspace bridge result from manage_navigation_bar");
    expect(errorCtx.messages[0].content).toContain("No navigation bar found");
    expect(errorCtx.messages[0].content).not.toContain("The dashboard does not have a navigation bar yet.");
  });

  it("forwards idempotent navigation/tab errors without continuation hints", async () => {
    const navExistsTool: ToolMessage = {
      role: "tool",
      function: "manage_navigation_bar",
      input_arguments: {
        operation: "create",
        tabs: [{ name: "Governance" }, { name: "Social" }],
      },
      data: [
        {
          status: "error",
          message: "Navigation bar already exists on this dashboard. Use 'add_tabs' to add new tabs.",
        },
      ] as unknown as ToolMessage["data"],
    };
    const tabExistsTool: ToolMessage = {
      role: "tool",
      function: "manage_navigation_bar",
      input_arguments: {
        operation: "add_tabs",
        tabs: [{ name: "Social" }],
      },
      data: [
        {
          status: "error",
          message: 'Tab "Social" already exists.',
        },
      ] as unknown as ToolMessage["data"],
    };

    const navCtx = emptyCtx();
    await drain(injectFromReboot(navExistsTool, navCtx));
    expect(navCtx.messages[0].content).toContain("Navigation bar already exists");
    expect(navCtx.messages[0].content).not.toContain("Do not call manage_dashboard again");

    const tabCtx = emptyCtx();
    await drain(injectFromReboot(tabExistsTool, tabCtx));
    expect(tabCtx.messages[0].content).toContain('Tab \\"Social\\" already exists.');
    expect(tabCtx.messages[0].content).not.toContain("Treat that tab as present");
  });

  it("emits concise update_widget success and error result details", async () => {
    const successTool: ToolMessage = {
      role: "tool",
      function: "update_widget_in_dashboard",
      input_arguments: {
        widget_uuid: "widget-1",
        config: { data_args: { symbol: "UNRATE" } },
      },
      data: [
        {
          status: "success",
          message: "Widget updated.",
          data: { ok: true, command: "update_widget_in_dashboard" },
        },
      ] as unknown as ToolMessage["data"],
    };
    const nativeSuccessTool: ToolMessage = {
      role: "tool",
      function: "update_widget_in_dashboard",
      input_arguments: {
        widget_uuid: "widget-1",
        config: { data_args: { symbol: "UNRATE" } },
      },
      data: [
        {
          ok: true,
          command: "update_widget_in_dashboard",
          message: "Widget updated.",
          data: {
            dashboard_id: "dashboard-1",
            widget_uuid: "widget-1",
          },
        },
      ] as unknown as ToolMessage["data"],
    };
    const errorTool: ToolMessage = {
      role: "tool",
      function: "update_widget_in_dashboard",
      input_arguments: {
        widget_uuid: "economy_fred_series_fred_obb",
      },
      data: [
        {
          status: "error",
          message: "update_widget_in_dashboard could not find widget_uuid 'economy_fred_series_fred_obb'.",
          data: { ok: false, command: "update_widget_in_dashboard" },
        },
      ] as unknown as ToolMessage["data"],
    };

    const successEvents = await drain(injectFromReboot(successTool, emptyCtx()));
    expect(successEvents[0].data.message).toBe("Widget update succeeded");
    expect(successEvents[0].data.details).toBeUndefined();

    const nativeSuccessEvents = await drain(injectFromReboot(nativeSuccessTool, emptyCtx()));
    expect(nativeSuccessEvents[0].data.message).toBe("Widget update succeeded");
    expect(nativeSuccessEvents[0].data.details).toBeUndefined();

    const errorEvents = await drain(injectFromReboot(errorTool, emptyCtx()));
    expect(errorEvents[0].data.message).toBe("Widget update failed");
    expect(errorEvents[0].data.details).toEqual([
      "update_widget_in_dashboard could not find widget_uuid 'economy_fred_series_fred_obb'.",
    ]);
  });

  it("handles update_widget_in_dashboard results directly as widget update results", async () => {
    const tool: ToolMessage = {
      role: "tool",
      function: "update_widget_in_dashboard",
      input_arguments: {
        widget_uuid: "widget-1",
        config: { data_args: { sector: "Financials" } },
      },
      data: [
        {
          status: "success",
          message: "Widget updated.",
          data: { ok: true, command: "update_widget_in_dashboard" },
        },
      ] as unknown as ToolMessage["data"],
    };

    const ctx = emptyCtx();
    const events = await drain(injectFromReboot(tool, ctx));

    expect(events[0].data.message).toBe("Widget update succeeded");
    expect(events[0].data.details).toBeUndefined();
    expect(ctx.messages[0].content).toContain("Workspace bridge result from update_widget_in_dashboard");
  });
});

describe("injectFromReboot — get_skill_content", () => {
  it("emits a compact skill-loaded status with only output preview details", async () => {
    const tool: ToolMessage = {
      role: "tool",
      function: "get_skill_content",
      input_arguments: { slug: "summarize-table" },
      data: [
        {
          status: "success",
          data: {
            skill: {
              contentMarkdown: "Use concise table summaries.",
            },
          },
        },
      ] as unknown as ToolMessage["data"],
    };
    const ctx = emptyCtx();

    const events = await drain(injectFromReboot(tool, ctx));

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("copilotStatusUpdate");
    expect(events[0].data.message).toBe('Skill "summarize-table" loaded');
    expect(events[0].data.details).toEqual([{ output_preview: "Use concise table summaries." }]);
  });
});

describe("injectFromReboot — widget data", () => {
  it("emits a loaded-data status with a table artifact", async () => {
    const widget: Widget = {
      uuid: "energy-widget",
      origin: "test",
      widget_id: "energy_vs_revenue",
      name: "Energy Consumption, Renewables and Revenue",
      description: "",
      params: [],
    };
    const tool: ToolMessage = {
      role: "tool",
      function: "get_widget_data",
      input_arguments: {
        data_sources: [{ widget_uuid: "energy-widget" }],
      },
      data: [
        {
          items: [
            {
              content: JSON.stringify([
                { Year: 2020, Renewable_Energy_Percent: 12 },
                { Year: 2021, Renewable_Energy_Percent: 17.75 },
              ]),
            },
          ],
        },
      ] as unknown as ToolMessage["data"],
    };
    const ctx = { ...emptyCtx(), allWidgets: [widget] };

    const events = await drain(injectFromReboot(tool, ctx));

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("copilotStatusUpdate");
    expect(events[0].data.message).toBe('Loaded "Energy Consumption, Renewables and Revenue" data.');
    expect((events[0].data as { artifacts?: unknown[] }).artifacts?.length).toBe(1);
    expect(ctx.pendingTables.has("energy_consumption__renewables_and_revenue")).toBe(true);
    const injected = (ctx.messages[0].content as Array<{ text: string }>)
      .map((part) => part.text)
      .join("\n");
    expect(injected).toContain('queryable table "energy_consumption__renewables_and_revenue"');
    expect(injected).toContain("Queryable columns — use these exact names");
    expect(injected).toContain('"year" (INTEGER; original label "Year")');
    expect(injected).toContain("Preview with queryable column names");
    expect(injected).toContain('"renewable_energy_percent": 12');
    expect(injected).not.toContain('"Renewable_Energy_Percent": 12');
    expect(injected).toContain("call peek_table before execute_sql or create_artifact");
    expect(injected).toContain("Never infer a column from the table/display name");
  });

  it("preserves get_widget_data input_args for citations and loaded-table context", async () => {
    const widget: Widget = {
      uuid: "economy_fred_series_fred_obb",
      origin: "Open Data Platform",
      widget_id: "economy_fred_series_fred_obb",
      name: "Fred Series",
      description: "Get data by series ID from FRED.",
      params: [
        { name: "symbol", type: "text", description: "", current_value: null },
        { name: "frequency", type: "text", description: "", current_value: null },
        { name: "provider", type: "text", description: "", default_value: "fred" },
      ],
    };
    const tool: ToolMessage = {
      role: "tool",
      function: "get_widget_data",
      input_arguments: {
        data_sources: [
          {
            widget_uuid: "economy_fred_series_fred_obb",
            input_args: { symbol: "UNRATE", frequency: "m" },
          },
        ],
      },
      data: [
        {
          items: [
            {
              content: JSON.stringify([
                { date: "2024-01-01", UNRATE: 3.7 },
                { date: "2024-02-01", UNRATE: 3.9 },
              ]),
            },
          ],
        },
      ] as unknown as ToolMessage["data"],
    };
    const ctx = { ...emptyCtx(), allWidgets: [widget] };

    await drain(injectFromReboot(tool, ctx));

    const cited = [...ctx.citedWidgets.values()];
    expect(cited).toHaveLength(1);
    expect(cited[0]).toMatchObject({
      widgetUuid: "economy_fred_series_fred_obb",
      inputArgs: {
        symbol: "UNRATE",
        frequency: "m",
        provider: "fred",
      },
    });
    const injected = (ctx.messages[0].content as Array<{ text: string }>)
      .map((part) => part.text)
      .join("\n");
    expect(injected).toContain("Loaded with input parameters:");
    expect(injected).toContain('"symbol":"UNRATE"');
    expect(injected).toContain('"frequency":"m"');
  });

  it("emits one loaded-data status per widget in a multi-widget response", async () => {
    const widgets: Widget[] = [
      {
        uuid: "energy-widget",
        origin: "Teixeira Duarte",
        widget_id: "energy_vs_revenue",
        name: "Energy Consumption, Renewables and Revenue",
        description: "",
        params: [],
      },
      {
        uuid: "narrative-widget",
        origin: "Teixeira Duarte",
        widget_id: "agent_insights",
        name: "Executive ESG Change Narrative",
        description: "",
        params: [{ name: "years", type: "text", description: "", current_value: ["2020", "2024"] }],
      },
    ];
    const tool: ToolMessage = {
      role: "tool",
      function: "get_widget_data",
      input_arguments: {
        data_sources: [
          { widget_uuid: "energy-widget" },
          { widget_uuid: "narrative-widget" },
        ],
      },
      data: [
        {
          items: [
            {
              content: JSON.stringify([
                { Year: 2020, Energy_Total_MWh: 980000 },
                { Year: 2021, Energy_Total_MWh: 964320 },
              ]),
            },
          ],
        },
        {
          items: [{ content: "Renewable energy share improved steadily." }],
        },
      ] as unknown as ToolMessage["data"],
    };
    const ctx = { ...emptyCtx(), allWidgets: widgets };

    const events = await drain(injectFromReboot(tool, ctx));

    expect(events).toHaveLength(2);
    expect(events[0].data.message).toBe('Loaded "Energy Consumption, Renewables and Revenue" data.');
    expect((events[0].data as { artifacts?: unknown[] }).artifacts?.length).toBe(1);
    expect(events[1].data.message).toBe('Loaded "Executive ESG Change Narrative" data.');
    expect(events[1].data.details).toBeUndefined();
    expect((events[1].data as { artifacts?: unknown[] }).artifacts?.[0]).toMatchObject({
      type: "html",
      name: "Executive ESG Change Narrative",
      description: "Content loaded from Executive ESG Change Narrative",
    });
    expect(String(((events[1].data as { artifacts?: Array<{ content?: unknown }> }).artifacts?.[0])?.content)).toContain("Renewable energy share improved steadily.");
    expect(JSON.stringify(events[1].data.artifacts)).not.toContain('"widgets"');
  });

  it("forwards empty widget data bridge results to the next model turn", async () => {
    const widget: Widget = {
      uuid: "fred-series",
      origin: "Open Data Platform",
      widget_id: "economy_fred_series_fred_obb",
      name: "Fred Series",
      description: "",
      params: [],
    };
    const tool: ToolMessage = {
      role: "tool",
      function: "get_widget_data",
      input_arguments: {
        data_sources: [
          {
            widget_uuid: "fred-series",
            input_args: {
              symbol: "UNRATE",
              frequency: "monthly",
              transform: "none",
            },
          },
        ],
      },
      data: [
        {
          status: "error",
          message: "Invalid transform: none",
        },
      ] as unknown as ToolMessage["data"],
    };
    const ctx = { ...emptyCtx(), allWidgets: [widget] };

    const events = await drain(injectFromReboot(tool, ctx));

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("copilotStatusUpdate");
    expect(events[0].data.message).toBe("get_widget_data: no usable data returned");
    expect(events[0].data.eventType).toBe("WARNING");
    expect(events[0].data.details).toEqual(["Invalid transform: none"]);
    const injected = ctx.messages.at(-1)?.content as string;
    expect(injected).toContain("get_widget_data bridge result");
    expect(injected).not.toContain("Do not retry the same get_widget_data call");
    expect(injected).toContain('"frequency": "monthly"');
    expect(injected).toContain("Invalid transform: none");
  });

  it("surfaces bridge content errors for empty widget data loads", async () => {
    const widget: Widget = {
      uuid: "economy_unemployment_oecd_obb",
      origin: "Open Data Platform",
      widget_id: "economy_unemployment_oecd_obb",
      name: "Unemployment",
      description: "",
      params: [],
    };
    const tool: ToolMessage = {
      role: "tool",
      function: "get_widget_data",
      input_arguments: {
        data_sources: [
          {
            widget_uuid: "economy_unemployment_oecd_obb",
            input_args: { provider: "fred" },
          },
        ],
      },
      data: [
        {
          content:
            "Fetching data for widget 'economy_unemployment_oecd_obb' returned HTTP 422. Input should be 'oecd'.",
        },
      ] as unknown as ToolMessage["data"],
    };
    const ctx = { ...emptyCtx(), allWidgets: [widget] };

    const events = await drain(injectFromReboot(tool, ctx));

    expect(events[0].data.message).toBe("get_widget_data: no usable data returned");
    expect(events[0].data.details).toEqual([
      "Fetching data for widget 'economy_unemployment_oecd_obb' returned HTTP 422. Input should be 'oecd'.",
    ]);
    const injected = ctx.messages.at(-1)?.content as string;
    expect(injected).toContain("Input should be 'oecd'");
  });

  it("keeps generic fetch failures as bridge output", async () => {
    const widget: Widget = {
      uuid: "real_gdp_trend",
      origin: "Caique Backend",
      widget_id: "real_gdp_trend",
      name: "Real GDP Trend",
      description: "",
      params: [],
      metadata: {
        endpoint: "https://api.example.test/chart/real_gdp_trend",
      },
    };
    const tool: ToolMessage = {
      role: "tool",
      function: "get_widget_data",
      input_arguments: {
        data_sources: [
          {
            widget_uuid: "real_gdp_trend",
            origin: "Caique Backend",
            id: "real_gdp_trend",
            input_args: {},
          },
        ],
      },
      data: [
        {
          error_type: "unexpected_error",
          content: "Failed to fetch",
        },
      ] as unknown as ToolMessage["data"],
    };
    const ctx = { ...emptyCtx(), allWidgets: [widget] };

    const events = await drain(injectFromReboot(tool, ctx));

    expect(events[0].data.message).toBe("get_widget_data: no usable data returned");
    expect(events[0].data.details).toEqual(["Failed to fetch"]);
    const injected = ctx.messages.at(-1)?.content as string;
    expect(injected).toContain("Failed to fetch");
    expect(injected).not.toContain("The backend endpoint is not accessible");
  });

  it("explains empty widget data bridge results when the bridge gives no error", async () => {
    const widget: Widget = {
      uuid: "fred-series",
      origin: "Open Data Platform",
      widget_id: "economy_fred_series_fred_obb",
      name: "Fred Series",
      description: "",
      params: [],
    };
    const tool: ToolMessage = {
      role: "tool",
      function: "get_widget_data",
      input_arguments: {
        data_sources: [
          {
            widget_uuid: "fred-series",
            input_args: {
              symbol: "UNRATE",
              frequency: "monthly",
              transform: "raw",
            },
          },
        ],
      },
      data: [{ items: [] }] as unknown as ToolMessage["data"],
    };
    const ctx = { ...emptyCtx(), allWidgets: [widget] };

    const events = await drain(injectFromReboot(tool, ctx));

    expect(events[0].data.message).toBe("get_widget_data: no usable data returned");
    expect(events[0].data.details).toEqual([
      "The widget data bridge returned no usable rows, text, files, or media.",
    ]);
  });
});

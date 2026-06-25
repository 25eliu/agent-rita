import { describe, expect, it } from "bun:test";
import {
  formatToolInputRejectedStatus,
  formatToolResultStatus,
  formatToolStartStatus,
  formatWidgetDataLoadedStatuses,
  formatWidgetDataLoadedStatus,
  formatWidgetDataRequestStatus,
  formatWidgetDataRequestStatuses,
} from "../../../../src/agent/tool-status";
import type { TableInfo } from "../../../../src/sql/loader";

describe("tool status formatting", () => {
  it("uses direct progress summaries and keeps code details renderable", () => {
    const status = formatToolStartStatus("execute_sql", {
      display_summary: "Checking the latest renewable energy trend",
      sql: "SELECT * FROM energy",
    });

    expect(status.message).toBe("Checking the latest renewable energy trend");
    expect(status.details).toBe("```sql\nSELECT * FROM energy\n```");

    const artifact = formatToolStartStatus("create_artifact", {
      display_summary: "Rendering chart",
      sql: "SELECT year, renewable_energy_percent FROM energy ORDER BY year",
      artifact: { type: "chart", chartType: "line", name: "Renewable Energy Trend" },
    });
    expect(artifact.message).toBe("Rendering chart");
    expect(artifact.details).toBe(
      "```sql\nSELECT year, renewable_energy_percent FROM energy ORDER BY year\n```",
    );

    const artifactFromTable = formatToolStartStatus("create_artifact", {
      from_table_id: "eu_taxonomy_revenue_and_capex_alignment",
      artifact: {
        type: "chart",
        chartType: "bar",
        name: "EU Taxonomy Alignment Progress",
      },
    });
    expect(artifactFromTable.message).toBe('Rendering bar chart "EU Taxonomy Alignment Progress"');
    expect(artifactFromTable.details).toBeUndefined();

    const withComment = formatToolStartStatus("execute_sql", {
      sql: "SELECT\n  year,\n  -- keep the next expression on its own line\n  close\nFROM prices",
    });
    expect(withComment.details).toBe(
      "```sql\nSELECT\n  year,\n  -- keep the next expression on its own line\n  close\nFROM prices\n```",
    );

    const python = formatToolStartStatus("execute_code", {
      code: "import pandas as pd\nprint(pd.__version__)",
    });
    expect(python.message).toBe("Running Python code");
    expect(python.details).toBe(
      "```python\nimport pandas as pd\nprint(pd.__version__)\n```",
    );

    const prefixedMcpPython = formatToolStartStatus(
      "agentritamcp_execute_code",
      {
        display_summary: "Generating random data and running a linear regression",
        code: "import numpy as np\nprint(np.__version__)",
      },
      {
        isMcp: true,
        actualToolName: "agentritamcp_execute_code",
      },
    );
    expect(prefixedMcpPython.message).toBe(
      "Generating random data and running a linear regression",
    );
    expect(prefixedMcpPython.details).toBe(
      "```python\nimport numpy as np\nprint(np.__version__)\n```",
    );
    expect(JSON.stringify(prefixedMcpPython.details)).not.toContain('"code"');

    const html = formatToolStartStatus("create_html_artifact", {
      html: "<h2>OpenBB Product Offerings</h2>",
      name: "OpenBB Product Offerings Diagram",
      description: "HTML diagram of OpenBB product offerings.",
    });
    expect(html.message).toBe("Rendering HTML artifact");
    expect(html.details).toBe("```html\n<h2>OpenBB Product Offerings</h2>\n```");
    expect(JSON.stringify(html.details)).not.toContain("input_params");
    expect(JSON.stringify(html.details)).not.toContain('"name"');

    const mermaid = formatToolStartStatus(
      "mermaid_diagram",
      {
        name: "OpenBB Product Offerings Flowchart",
        description: "A flowchart diagram of OpenBB product offerings.",
        code: "flowchart TD\n  A[OpenBB] --> B[Workspace]",
      },
      { isMcp: true, actualToolName: "mermaid_diagram" },
    );
    expect(mermaid.details).toBe(
      "```mermaid\nflowchart TD\n  A[OpenBB] --> B[Workspace]\n```",
    );
    expect(JSON.stringify(mermaid.details)).not.toContain('"code"');
    expect(JSON.stringify(mermaid.details)).not.toContain('"name"');
  });

  it("uses the actual tool name for MCP tools and web searches", () => {
    const mcp = formatToolStartStatus(
      "LinqAlpha_web_search",
      { query: "MacBook Neo reddit reaction site:reddit.com" },
      {
        isMcp: true,
        actualToolName: "LinqAlpha_web_search",
      },
    );
    expect(mcp.message).toBe('Searching "MacBook Neo reddit reaction site:reddit.com"');
    expect(mcp.details).toEqual({
      query: "MacBook Neo reddit reaction site:reddit.com",
    });
    expect(mcp.artifacts).toBeUndefined();
    expect(JSON.stringify(mcp.details)).not.toContain("input_params");
    expect(JSON.stringify(mcp.details)).not.toContain("actual_tool_name");

    const out = formatToolResultStatus(
      "execute_code",
      { code: "print(1)" },
      "ok",
      { isMcp: true },
    );
    expect(out.message).toBe("execute_code returned a result");
    expect(out.details).toMatchObject({
      phase: "output",
      category: "tool_output",
      tool_name: "execute_code",
    });
  });

  it("describes table peeks with only the requested limit in details", () => {
    const status = formatToolStartStatus("peek_table", {
      table_name: "ctx_latest_esg_kpi_snapshot_table",
      limit: 10,
    });

    expect(status.message).toBe('Previewing table "Latest ESG KPI Snapshot"');
    expect(status.details).toEqual({
      limit: 10,
    });
    expect(JSON.stringify(status.details)).not.toContain("table_name");
    expect(JSON.stringify(status.details)).not.toContain("display_name");
  });

  it("shows only supplied filters for list_available_widgets calls", () => {
    const status = formatToolStartStatus("list_available_widgets", {
      origin: "Open Data Platform",
      backend_id: null,
      display_summary: "Listing Open Data Platform widgets",
    });

    expect(status.message).toBe("Listing Open Data Platform widgets");
    expect(status.details).toEqual({
      origin: "Open Data Platform",
    });
    expect(JSON.stringify(status.details)).not.toContain("phase");
    expect(JSON.stringify(status.details)).not.toContain("input_params");
    expect(JSON.stringify(status.details)).not.toContain("backend_id");

    const empty = formatToolStartStatus("list_available_widgets", {});
    expect(empty.message).toBe("Listing available widgets");
    expect(empty.details).toBeUndefined();
  });

  it("uses a compact get_workspace_snapshot start status", () => {
    const status = formatToolStartStatus("get_workspace_snapshot", {});

    expect(status.message).toBe("Reading current workspace state");
    expect(status.details).toBeUndefined();
  });

  it("keeps dashboard creation start status title-only", () => {
    const status = formatToolStartStatus("manage_dashboard", {
      operation: "create",
      name: "ESG Governance Dashboard",
    });

    expect(status.message).toBe('Creating dashboard "ESG Governance Dashboard"');
    expect(status.details).toBeUndefined();
  });

  it("shows only tab names for navigation bar changes", () => {
    const status = formatToolStartStatus("manage_navigation_bar", {
      operation: "add_tabs",
      tabs: [{ name: "Governance" }, { name: "Social" }],
    });

    expect(status.message).toBe("Adding dashboard tabs");
    expect(status.details).toBe("Governance, Social");
    expect(JSON.stringify(status.details)).not.toContain("phase");
    expect(JSON.stringify(status.details)).not.toContain("input_params");
    expect(JSON.stringify(status.details)).not.toContain("operation");
  });

  it("uses a specific message when creating dashboard navigation", () => {
    const status = formatToolStartStatus("manage_navigation_bar", {
      operation: "create",
      tabs: [{ name: "Governance" }, { name: "Social" }],
    });

    expect(status.message).toBe("Creating dashboard navigation");
    expect(status.details).toBe("Governance, Social");
  });

  it("shows only origin and widget name for get_widget_schema calls", () => {
    const status = formatToolStartStatus("get_widget_schema", {
      origin: "Open Data Platform",
      widget_id: "economy_fred_series_fred_obb_chart",
      widget_name: "Fred Series (Chart)",
    });

    expect(status.message).toBe("Loading schema for Fred Series (Chart)");
    expect(status.details).toEqual({
      origin: "Open Data Platform",
      widget_name: "Fred Series (Chart)",
    });
    expect(JSON.stringify(status.details)).not.toContain("phase");
    expect(JSON.stringify(status.details)).not.toContain("input_params");
    expect(JSON.stringify(status.details)).not.toContain("widget_id");
  });

  it("falls back to a readable widget label for get_widget_schema calls", () => {
    const status = formatToolStartStatus("get_widget_schema", {
      origin: "Open Data Platform",
      widget_id: "economy_fred_series_fred_obb",
    });

    expect(status.message).toBe("Loading schema for Economy Fred Series Fred Obb");
    expect(status.details).toEqual({
      origin: "Open Data Platform",
      widget_name: "Economy Fred Series Fred Obb",
    });
    expect(JSON.stringify(status.details)).not.toContain("widget_id");
  });

  it("shows create_widget catalog identity with widget name and params", () => {
    const status = formatToolStartStatus("add_widget_to_dashboard", {
      origin: "Open Data Platform",
      widget_id: "economy_fred_series_fred_obb",
      widget_name: "Fred Series",
      config: {
        data_args: {
          symbol: "UNRATE",
          provider: "fred",
          start_date: "2019-01-01",
        },
        ui_args: {},
      },
    });

    expect(status.message).toBe('Adding "Fred Series" to dashboard');
    expect(status.details).toEqual({
      origin: "Open Data Platform",
      widget_name: "Fred Series",
      params: {
        symbol: "UNRATE",
        provider: "fred",
        start_date: "2019-01-01",
      },
    });
    expect(JSON.stringify(status.details)).not.toContain("phase");
    expect(JSON.stringify(status.details)).not.toContain("input_params");
    expect(JSON.stringify(status.details)).not.toContain("config");
  });

  it("shows update_widget with widget name and direct params only", () => {
    const status = formatToolStartStatus("update_widget_in_dashboard", {
      dashboard_id: "dash-1",
      widget_uuid: "widget-1",
      widget_name: "Fred Series",
      config: {
        data_args: {
          filter_text: "B",
        },
        ui_args: {},
      },
    });

    expect(status.message).toBe('Updating "Fred Series"');
    expect(status.details).toEqual({
      filter_text: "B",
    });
    expect(JSON.stringify(status.details)).not.toContain("phase");
    expect(JSON.stringify(status.details)).not.toContain("input_params");
    expect(JSON.stringify(status.details)).not.toContain("config");
    expect(JSON.stringify(status.details)).not.toContain("widget-1");
    expect(JSON.stringify(status.details)).not.toContain("dash-1");
  });

  it("shows enhance_prompt query/result as plain details", () => {
    const start = formatToolStartStatus("enhance_prompt", {
      reasoning: "Need a valid transform.",
      query:
        "Which transform would you like to apply for the UNRATE series? Options: chg, ch1, pch, pc1, pca, cch, cca, log.",
    });

    expect(start.details).toBe(
      "Which transform would you like to apply for the UNRATE series? Options: chg, ch1, pch, pc1, pca, cch, cca, log.",
    );

    const result = formatToolResultStatus(
      "enhance_prompt",
      { query: "Pick a transform" },
      "Please specify a valid transform for the UNRATE series.",
    );

    expect(result.message).toBe("enhance_prompt returned a result");
    expect(result.details).toBe("Please specify a valid transform for the UNRATE series.");
  });

  it("does not parse tool output text into deterministic result paths", () => {
    const status = formatToolResultStatus(
      "peek_table",
      { table_name: "energy" },
      'Table "energy" (5 rows total)\n' +
        'Columns:\n  - "year" (INTEGER)\n  - "renewable_energy_percent" (REAL)\n\n' +
        'First 2 rows:\n[{"year":2024,"renewable_energy_percent":35}]',
    );

    expect(status.message).toBe("peek_table returned a result");
    expect(status.details).toMatchObject({
      output_preview: expect.stringContaining('Table "energy"'),
    });
    expect(status.artifacts).toBeUndefined();

    const missing = formatToolResultStatus(
      "peek_table",
      { table_name: "missing" },
      'Table "missing" not loaded. Available: "energy".',
    );
    expect(missing.message).toBe("peek_table returned a result");
    expect((missing.details as Record<string, unknown>).output_preview).toContain(
      'Table "missing" not loaded',
    );

    const noTables = formatToolResultStatus(
      "peek_table",
      { display_summary: "Checking available tables" },
      "No tables shipped to compute. Did the widget data round-trip complete?",
    );
    expect(noTables.message).toBe("peek_table returned a result");
    expect(noTables.eventType).toBe("INFO");

    const sql = formatToolResultStatus(
      "execute_sql",
      { sql: "SELECT year, renewable_energy_percent FROM energy" },
      "SQL: SELECT year, renewable_energy_percent FROM energy\nRows: 1\n\n" +
        '[{"year":2024,"renewable_energy_percent":35}]',
    );
    expect(sql.message).toBe("execute_sql returned a result");
    expect(sql.generic).toBe(true);
    expect(JSON.stringify(sql.details)).toContain("Rows: 1");
    expect(sql.artifacts).toBeUndefined();

    const sqlError = formatToolResultStatus(
      "execute_sql",
      {
        display_summary: "Fetching renewable energy share trend",
        sql: "SELECT year, renewable_energy_share FROM ctx_latest_esg_kpi_snapshot_table ORDER BY year;",
      },
      'SQL error: no such column: year. Available tables: "ctx_latest_esg_kpi_snapshot_table" (8 rows; columns: -, -, -, -)',
    );
    expect(sqlError.message).toBe("execute_sql returned a result");
    expect(sqlError.generic).toBe(true);
    expect(sqlError.eventType).toBe("INFO");
    expect(JSON.stringify(sqlError.details)).toContain("SQL error: no such column: year");
    expect(JSON.stringify(sqlError.details)).toContain("input_params");
    expect(JSON.stringify(sqlError.details)).toContain("output_preview");

    const emptySql = formatToolResultStatus(
      "execute_sql",
      {
        display_summary: "Comparing Scope 3 emissions by geography",
        sql: "SELECT country FROM master_database WHERE business_unit = 'Group Consolidated'",
      },
      "SQL: SELECT country FROM master_database WHERE business_unit = 'Group Consolidated'\nRows: 0\n\n[]",
    );
    expect(emptySql.message).toBe("execute_sql returned a result");
    expect(emptySql.generic).toBe(true);
    expect(JSON.stringify(emptySql.details)).toContain("Rows: 0");
  });

  it("summarizes widget search results by count and emits a match artifact", () => {
    const status = formatToolResultStatus(
      "search_widgets",
      { query: "renewable" },
      {
        total: 2,
        matches: [
          {
            name: "Indexed ESG Trend Comparison",
            uuid: "trend",
            origin: "Teixeira Duarte",
            params: ["business_unit:text=Group", "years:text=2020,2024"],
          },
          {
            name: "Energy Consumption, Renewables and Revenue",
            uuid: "energy",
            origin: "Teixeira Duarte",
            params: ["business_unit:text=Group", "years:text=2020,2024"],
          },
        ],
      },
    );

    expect(status.message).toBe("Found 2 widget matches.");
    expect(status.details).toBeUndefined();
    expect(status.artifacts?.[0]).toMatchObject({
      type: "table",
      name: "Widget Matches",
      content: [
        {
          backend: "Teixeira Duarte",
          name: "Indexed ESG Trend Comparison",
          description: null,
        },
        {
          backend: "Teixeira Duarte",
          name: "Energy Consumption, Renewables and Revenue",
          description: null,
        },
      ],
    });
  });

  it("makes partial widget search result artifacts explicit", () => {
    const status = formatToolResultStatus(
      "search_widgets",
      { query: "FRED" },
      {
        total: 75,
        matches: [
          {
            name: "Fred Series",
            origin: "Open Data Platform",
            description: "Get data by series ID from FRED.",
          },
          {
            name: "Fred Series (Chart)",
            origin: "Open Data Platform",
            description: "Get data by series ID from FRED.",
          },
        ],
      },
    );

    expect(status.message).toBe("Found 75 widget matches (showing 2).");
    expect(status.artifacts?.[0]).toMatchObject({
      type: "table",
      name: "Widget Matches",
      description: "Showing 2 of 75 widgets matching the search query.",
      content: [
        {
          backend: "Open Data Platform",
          name: "Fred Series",
          description: "Get data by series ID from FRED.",
        },
        {
          backend: "Open Data Platform",
          name: "Fred Series (Chart)",
          description: "Get data by series ID from FRED.",
        },
      ],
    });
  });

  it("does not parse create_artifact output text, but still renders loaded widget tables", () => {
    const artifact = formatToolResultStatus(
      "create_artifact",
      {
        artifact: { type: "chart", chartType: "line", name: "Renewable Energy Trend" },
      },
      'Created chart artifact "Renewable Energy Trend" from 5 rows. The artifact is now rendered.',
    );
    expect(artifact.message).toBe('Rendered chart artifact "Renewable Energy Trend" from 5 rows.');
    expect(artifact.generic).toBeUndefined();
    expect(artifact.details).toBeUndefined();

    const table: TableInfo = {
      tableName: "energy_consumption__renewables_and_revenue",
      rowCount: 5,
      columns: [
        { name: "year", originalName: "Year", type: "INTEGER" },
        {
          name: "renewable_energy_percent",
          originalName: "Renewable_Energy_Percent",
          type: "REAL",
        },
      ],
    };
    const loaded = formatWidgetDataLoadedStatus(
      [
        {
          name: "Energy Consumption, Renewables and Revenue",
          uuid: "energy",
          content: "[{}]",
        },
      ],
      [table],
      {
        tableRows: new Map([
          [
            "energy_consumption__renewables_and_revenue",
            [{ year: 2024, renewable_energy_percent: 35 }],
          ],
        ]),
      },
    );

    expect(loaded.message).toBe('Loaded "Energy Consumption, Renewables and Revenue" data.');
    expect(loaded.details).toBeUndefined();
    expect(loaded.artifacts?.[0]).toMatchObject({
      type: "table",
      name: "Energy Consumption, Renewables and Revenue",
      content: [{ year: 2024, renewable_energy_percent: 35 }],
    });

    const cached = formatWidgetDataLoadedStatus(
      [
        {
          name: "Energy Consumption, Renewables and Revenue",
          uuid: "energy",
          content: JSON.stringify([
            { Year: 2023, Renewable_Energy_Percent: 29.25 },
            { Year: 2024, Renewable_Energy_Percent: 35 },
          ]),
        },
      ],
      [],
      { cached: true },
    );
    expect(cached.message).toBe('Using cached "Energy Consumption, Renewables and Revenue" data.');
    expect(cached.artifacts?.[0]).toMatchObject({
      type: "table",
      content: [
        { Year: 2023, Renewable_Energy_Percent: 29.25 },
        { Year: 2024, Renewable_Energy_Percent: 35 },
      ],
    });
  });

  it("separates rejected tool input from validation output", () => {
    const status = formatToolInputRejectedStatus(
      "create_artifact",
      {
        artifact: { type: "chart", chartType: "line", name: "Renewable Energy Share Trend" },
        data: null,
        sql: 'SELECT "Year" FROM "energy_consumption__renewables_and_revenue"',
      },
      'Invalid input for tool create_artifact: Type validation failed: Value: {"data":null}. Error message: [{"path":["data"],"message":"Invalid input: expected array, received null"}]',
    );

    expect(status.message).toBe("Input rejected");
    expect(status.details).toBe("data: Invalid input: expected array, received null");
    expect(JSON.stringify(status.details)).not.toContain('"data":null');
    expect(JSON.stringify(status.details)).not.toContain("SELECT");
    expect(JSON.stringify(status.details)).not.toContain("Renewable Energy Share Trend");
    expect(JSON.stringify(status.details)).not.toContain("output_preview");
  });

  it("keeps failed artifact output as a generic tool result", () => {
    const status = formatToolResultStatus(
      "create_artifact",
      {
        display_summary: "Plotting renewable energy share trend",
        data: [],
        from_table_id: "master_database",
        artifact: {
          type: "chart",
          chartType: "line",
          xKey: "year",
          yKey: ["avg_percent"],
          name: "Renewable Energy Share Trend",
          description: "Average renewable energy share per year",
        },
      },
      "Error: pass exactly one of `sql`, `data`, or `from_table_id` — not multiple.",
    );

    expect(status.message).toBe("Artifact rendering failed");
    expect(status.generic).toBe(true);
    expect(status.eventType).toBe("INFO");
    expect(JSON.stringify(status.details)).toContain("pass exactly one of");
    expect(JSON.stringify(status.details)).toContain("output_preview");
  });

  it("shows rejected execute_code details as Python code only", () => {
    const status = formatToolInputRejectedStatus(
      "execute_code",
      {
        code: "import pandas as pd\nprint('hello')",
      },
      "Model tried to call unavailable tool 'execute_code'.",
    );

    expect(status.message).toBe("Input rejected");
    expect(status.eventType).toBe("WARNING");
    expect(status.details).toBe("```python\nimport pandas as pd\nprint('hello')\n```");
    expect(JSON.stringify(status.details)).not.toContain("unavailable tool");
    expect(JSON.stringify(status.details)).not.toContain("input_params");
  });

  it("shows rejected get_widget_data details as the validation message only", () => {
    const status = formatToolInputRejectedStatus(
      "get_widget_data",
      { widgets: [{ uuid: "economy_unemployment_oecd_obb", params: { country: "united_states" } }] },
      "widgets.0.widget_uuid: Invalid input: expected string, received undefined",
    );

    expect(status.message).toBe("Input rejected");
    expect(status.eventType).toBe("WARNING");
    expect(status.details).toBe(
      "widgets.0.widget_uuid: Invalid input: expected string, received undefined",
    );
    expect(JSON.stringify(status.details)).not.toContain("params");
  });

  it("describes resolved widget-data requests with concrete params", () => {
    const status = formatWidgetDataRequestStatus([
      {
        uuid: "energy",
        origin: "Teixeira Duarte",
        widget_id: "energy_vs_revenue",
        name: "Energy Consumption, Renewables and Revenue",
        description: "",
        params: [
          { name: "business_unit", type: "text", description: "", current_value: "Group" },
          { name: "years", type: "text", description: "", current_value: ["2020", "2024"] },
        ],
      },
    ]);

    expect(status.message).toBe('Loading "Energy Consumption, Renewables and Revenue"');
    expect(status.details).toMatchObject({
      backend: "Teixeira Duarte",
      name: "Energy Consumption, Renewables and Revenue",
      params: {
        business_unit: "Group",
        years: "2020, 2024",
      },
    });

    const withSql = formatWidgetDataRequestStatus(
      [
        {
          uuid: "energy",
          origin: "Teixeira Duarte",
          widget_id: "energy_vs_revenue",
          name: "Energy Consumption, Renewables and Revenue",
          description: "",
          params: [],
        },
      ],
      { sql: "SELECT * FROM energy" },
    );
    expect(withSql.details).toMatchObject({ SQL: "SELECT * FROM energy" });
    expect(withSql.details).not.toHaveProperty("params");

    const multi = formatWidgetDataRequestStatuses([
      {
        uuid: "trends",
        origin: "Teixeira Duarte",
        widget_id: "esg_trends_5y",
        name: "Indexed ESG Trend Comparison",
        description: "",
        params: [
          { name: "business_unit", type: "text", description: "", current_value: "Group_Consolidated" },
          {
            name: "geographies",
            type: "text",
            description: "",
            current_value: ["Angola", "Brazil"],
          },
        ],
      },
      {
        uuid: "master",
        origin: "Teixeira Duarte",
        widget_id: "master_database",
        name: "Master Database",
        description: "",
        params: [],
      },
    ]);
    expect(multi.map((status) => status.message)).toEqual([
      'Loading "Indexed ESG Trend Comparison"',
      'Loading "Master Database"',
    ]);
    expect(multi.map((status) => status.details)).toEqual([
      {
        backend: "Teixeira Duarte",
        name: "Indexed ESG Trend Comparison",
        params: {
          business_unit: "Group_Consolidated",
          geographies: "Angola, Brazil",
        },
      },
      {
        backend: "Teixeira Duarte",
        name: "Master Database",
      },
    ]);
    expect(JSON.stringify(multi)).not.toContain('"widgets"');
  });

  it("uses compact skill status details", () => {
    const start = formatToolStartStatus("get_skill_content", {
      slug: "summarize-table",
      reason: "The user asked to summarize ESG trends.",
    });
    expect(start.message).toBe('Loading skill "summarize-table"');
    expect(start.details).toBe("The user asked to summarize ESG trends.");
  });

  it("renders larger loaded widget datasets as table artifacts", () => {
    const rows = Array.from({ length: 155 }, (_, index) => ({
      year: 2020 + (index % 5),
      renewable_energy_percent: index,
    }));
    const table: TableInfo = {
      tableName: "master_database",
      rowCount: rows.length,
      columns: [
        { name: "year", originalName: "Year", type: "INTEGER" },
        {
          name: "renewable_energy_percent",
          originalName: "Renewable_Energy_Percent",
          type: "REAL",
        },
      ],
    };
    const loaded = formatWidgetDataLoadedStatus(
      [
        {
          name: "Master Database",
          uuid: "master",
          content: JSON.stringify(rows),
        },
      ],
      [table],
      {
        tableRows: new Map([["master_database", rows]]),
      },
    );

    expect(loaded.message).toBe('Loaded "Master Database" data.');
    expect(loaded.details).toBeUndefined();
    expect(loaded.artifacts?.[0]).toMatchObject({
      type: "table",
      name: "Master Database",
    });
    const artifact = loaded.artifacts?.[0] as { content?: unknown[] } | undefined;
    expect(artifact?.content).toHaveLength(155);
  });

  it("renders huge loaded widget datasets as capped table artifacts", () => {
    const rows = Array.from({ length: 1_200 }, (_, index) => ({
      date: `2024-01-${String((index % 31) + 1).padStart(2, "0")}`,
      unrate: index / 10,
    }));
    const table: TableInfo = {
      tableName: "fred_series",
      rowCount: rows.length,
      columns: [
        { name: "date", originalName: "date", type: "TEXT" },
        { name: "unrate", originalName: "UNRATE", type: "REAL" },
      ],
    };
    const loaded = formatWidgetDataLoadedStatus(
      [
        {
          name: "Fred Series",
          uuid: "economy_fred_series_fred_obb",
          content: JSON.stringify(rows),
        },
      ],
      [table],
      {
        tableRows: new Map([["fred_series", rows]]),
      },
    );

    expect(loaded.message).toBe('Loaded "Fred Series" data.');
    expect(loaded.details).toBeUndefined();
    expect(loaded.artifacts?.[0]).toMatchObject({
      type: "table",
      name: "Fred Series",
      description: "Rows loaded from Fred Series (showing first 1000 of 1200 rows).",
    });
    const artifact = loaded.artifacts?.[0] as { content?: unknown[] } | undefined;
    expect(artifact?.content).toHaveLength(1_000);
  });

  it("keeps compact details when only part of a widget load is artifacted", () => {
    const table: TableInfo = {
      tableName: "prices",
      rowCount: 1,
      columns: [{ name: "close", originalName: "Close", type: "INTEGER" }],
    };
    const loaded = formatWidgetDataLoadedStatuses(
      [
        {
          name: "Price Table",
          uuid: "prices",
          content: JSON.stringify([{ close: 100 }]),
        },
        {
          name: "Price Narrative",
          uuid: "narrative",
          content: "Narrative text that is not structured rows.",
          widget: {
            uuid: "narrative",
            origin: "Teixeira Duarte",
            widget_id: "price_narrative",
            name: "Price Narrative",
            description: "",
            params: [{ name: "years", type: "text", description: "", current_value: ["2023", "2024"] }],
          },
        },
      ],
      [table],
      { tableRows: new Map([["prices", [{ close: 100 }]]]) },
    );

    expect(loaded).toHaveLength(2);
    expect(loaded[0].message).toBe('Loaded "Price Table" data.');
    expect(loaded[0].artifacts).toHaveLength(1);
    expect(loaded[0].details).toBeUndefined();
    expect(loaded[1].message).toBe('Loaded "Price Narrative" data.');
    expect(loaded[1].details).toBeUndefined();
    const narrativeArtifact = loaded[1].artifacts?.[0];
    expect(narrativeArtifact).toMatchObject({
      type: "html",
      name: "Price Narrative",
      description: "Content loaded from Price Narrative",
    });
    if (narrativeArtifact?.type !== "html") throw new Error("Expected an HTML artifact");
    expect(narrativeArtifact.content).toContain("Narrative text that is not structured rows.");
    expect(JSON.stringify(loaded[1].artifacts)).not.toContain('"widgets"');
  });
});

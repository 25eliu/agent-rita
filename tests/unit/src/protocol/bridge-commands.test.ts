/**
 * Tier 1 — vendored bridge command contract.
 *
 * Verifies:
 *   - Registry covers the 16 commands in bridge-commands.ts (PR2 surface)
 *   - WORKSPACE_BRIDGE_COMMAND_NAMES set agrees with the registry
 *   - Each command's Zod schema parses a representative example
 *   - Schemas reject obvious shape errors
 */

import { describe, it, expect } from "bun:test";
import {
  WORKSPACE_BRIDGE_COMMANDS,
  WORKSPACE_BRIDGE_COMMAND_NAMES,
  createWidgetInputSchema,
  listAvailableWidgetsInputSchema,
  isWorkspaceBridgeCommand,
} from "../../../../src/protocol/bridge-commands";

const EXPECTED_NAMES = [
  "get_workspace_snapshot",
  "list_available_widgets",
  "get_widget_schema",
  "get_params_options",
  "read_widget",
  "add_widget_to_dashboard",
  "update_widget_in_dashboard",
  "delete_widget",
  "manage_dashboard",
  "update_dashboard_layout",
  "manage_navigation_bar",
  "add_generative_widget",
  "assign_tasks_to_agents",
  "navigate_workspace",
  "manage_backends",
  "manage_apps",
] as const;

describe("WORKSPACE_BRIDGE_COMMANDS — registry", () => {
  it("contains exactly the 16 documented commands", () => {
    expect(WORKSPACE_BRIDGE_COMMANDS.map((c) => c.name).sort()).toEqual(
      [...EXPECTED_NAMES].sort(),
    );
  });

  it("WORKSPACE_BRIDGE_COMMAND_NAMES set agrees with the registry", () => {
    expect([...WORKSPACE_BRIDGE_COMMAND_NAMES].sort()).toEqual(
      [...EXPECTED_NAMES].sort(),
    );
  });

  it("isWorkspaceBridgeCommand matches set membership", () => {
    for (const n of EXPECTED_NAMES) expect(isWorkspaceBridgeCommand(n)).toBe(true);
    expect(isWorkspaceBridgeCommand("execute_agent_tool")).toBe(false);
    expect(isWorkspaceBridgeCommand("get_widget_data")).toBe(false);
    expect(isWorkspaceBridgeCommand("get_skill_content")).toBe(false);
    expect(isWorkspaceBridgeCommand("search_widgets")).toBe(false);
  });

  it("every command has a non-empty description and a ZodObject schema", () => {
    for (const c of WORKSPACE_BRIDGE_COMMANDS) {
      expect(c.description.length).toBeGreaterThan(20);
      expect(typeof c.inputSchema.parse).toBe("function");
    }
  });
});

const EXAMPLES: Record<string, unknown> = {
  get_workspace_snapshot: {},
  list_available_widgets: { origin: "Options Activity Monitor" },
  get_widget_schema: { origin: "openbb", widget_id: "options_chain" },
  get_params_options: {
    param_options_queries: [
      { origin: "openbb", widget_id: "x", param_name: "ticker", data_args: { exchange: "NASDAQ" } },
    ],
  },
  read_widget: { widget_uuid: "u-1" },
  add_widget_to_dashboard: {
    origin: "openbb",
    widget_id: "options_chain",
    config: { data_args: { symbol: "AAPL" }, ui_args: null },
  },
  update_widget_in_dashboard: {
    widget_uuid: "u-1",
    config: { data_args: { symbol: "MSFT" } },
  },
  delete_widget: { widget_uuid: "u-1" },
  manage_dashboard: { operation: "create", name: "My Dashboard", activate: true },
  update_dashboard_layout: { x: 0, y: 0, w: 20, h: 10, widget_uuid: "u-1" },
  manage_navigation_bar: {
    operation: "add_tabs",
    tabs: [{ name: "AAPL Analysis" }],
  },
  add_generative_widget: {
    widget_type: "chart",
    name: "Price",
    description: "AAPL close",
    data: [{ x: 1, y: 100 }],
    chart_params: { chartType: "line", xKey: "x", yKey: ["y"] },
  },
  assign_tasks_to_agents: {
    task_requests: [
      { id: "t-1", description: "Do the thing", assigned_agent_id: "a-1" },
    ],
  },
  navigate_workspace: { operation: "tab", tab_id: "aapl-analysis" },
  manage_backends: { operation: "add", name: "OpenBB", url: "https://example.com" },
  manage_apps: { operation: "list", backend_id: "b-1" },
};

describe("WORKSPACE_BRIDGE_COMMANDS — example payloads parse round-trip", () => {
  for (const c of WORKSPACE_BRIDGE_COMMANDS) {
    it(`${c.name} parses its example`, () => {
      const example = EXAMPLES[c.name];
      const parsed = c.inputSchema.safeParse(example);
      if (!parsed.success) {
        // Surface the failure; fail with clear message.
        throw new Error(
          `${c.name} schema rejected example: ${JSON.stringify(parsed.error.issues)}`,
        );
      }
      // Round-trip: re-parsing the parsed value must succeed.
      const second = c.inputSchema.safeParse(parsed.data);
      expect(second.success).toBe(true);
    });
  }
});

describe("list_available_widgets schema", () => {
  it("preserves optional filters for the bridge", () => {
    const parsed = listAvailableWidgetsInputSchema.parse({
      origin: " Open Data Platform ",
      backend_id: "   ",
    });

    expect(parsed.origin).toBe(" Open Data Platform ");
    expect(parsed.backend_id).toBe("   ");
  });

  it("allows placeholder-like backend ids to pass through schema validation", () => {
    const parsed = listAvailableWidgetsInputSchema.safeParse({
      origin: "Open Data Platform",
      backend_id: "<backend_id>",
    });

    expect(parsed.success).toBe(true);
  });
});

describe("create_widget schema", () => {
  it("preserves dashboard_id for the bridge", () => {
    const parsed = createWidgetInputSchema.parse({
      origin: "Open Data Platform",
      widget_id: "economy_fred_series_fred_obb",
      dashboard_id: "   ",
    });

    expect(parsed.dashboard_id).toBe("   ");
  });

  it("does not reject dashboard display-name-shaped dashboard_id values", () => {
    const parsed = createWidgetInputSchema.safeParse({
      origin: "Open Data Platform",
      widget_id: "economy_fred_series_fred_obb",
      dashboard_id: "Teixeira Duarte ESG Dashboard (2)",
    });

    expect(parsed.success).toBe(true);
  });
});

describe("update_widget description", () => {
  it("requires exact parameter values and candidate inspection", () => {
    const spec = WORKSPACE_BRIDGE_COMMANDS.find((c) => c.name === "update_widget_in_dashboard")!;
    expect(spec.description).toContain("only after identifying the target widget instances");
    expect(spec.description).toContain("Do not guess enum/dropdown values");
    expect(spec.description).toContain("pass option values, not labels");
    expect(spec.description).toContain("preserve the user's literal casing");
  });
});

describe("WORKSPACE_BRIDGE_COMMANDS — common shape errors are rejected", () => {
  it("manage_dashboard rejects unknown operation", () => {
    const spec = WORKSPACE_BRIDGE_COMMANDS.find((c) => c.name === "manage_dashboard")!;
    expect(spec.inputSchema.safeParse({ operation: "delete" }).success).toBe(false);
  });

  it("update_dashboard_layout requires x/y/w/h", () => {
    const spec = WORKSPACE_BRIDGE_COMMANDS.find(
      (c) => c.name === "update_dashboard_layout",
    )!;
    expect(spec.inputSchema.safeParse({ widget_uuid: "u-1" }).success).toBe(false);
  });

  it("add_generative_widget rejects unknown widget_type", () => {
    const spec = WORKSPACE_BRIDGE_COMMANDS.find(
      (c) => c.name === "add_generative_widget",
    )!;
    expect(spec.inputSchema.safeParse({ widget_type: "tree" }).success).toBe(false);
  });

  it("manage_apps requires backend_id", () => {
    const spec = WORKSPACE_BRIDGE_COMMANDS.find((c) => c.name === "manage_apps")!;
    expect(spec.inputSchema.safeParse({ operation: "list" }).success).toBe(false);
  });
});

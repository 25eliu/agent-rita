/**
 * Vendored OpenBB Workspace bridge command contract.
 *
 * The frontend's `useWorkspaceBridgeCommandHandler` (terminalpro) is the
 * authoritative dispatcher for these commands. The agent declares each one
 * as a no-execute Vercel AI SDK tool and emits a `copilotFunctionCall`
 * SSE with `function: <command>` and `input_arguments: <command shape>`.
 *
 * Source of truth (kept byte-compatible):
 *   terminalpro/src/components/AI/workspaceBridgeProtocol.ts
 *
 * What lives here:
 *   1. Per-command Zod schemas (what the model fills in).
 *   2. Per-command descriptions (what the model reads).
 *   3. WORKSPACE_BRIDGE_COMMANDS table — single registry consumed by:
 *      - src/agent/tools/workspace.ts (factory)
 *      - src/agent/loop.ts (generic dispatch on toolCall.toolName)
 *      - src/mcp/factory.ts (filter Path-B duplicates from body.tools)
 *
 * The 16 commands listed below are the new native-SSE surface migrated from
 * the workspace MCP wrappers. `get_widget_data` and `get_skill_content` are
 * also bridge commands but keep their bespoke agent paths (widget tier
 * resolution, skill payload injection) and so are NOT in this table.
 */

import { z } from "zod";

// ---------- shared shapes ----------

const widgetConfigSchema = z
  .object({
    data_args: z.record(z.string(), z.unknown()).nullable().optional(),
    ui_args: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .describe(
    "Widget config split into data_args (data inputs) and ui_args (UI inputs). " +
      "Layout fields belong on update_dashboard_layout, not here.",
  );

const backendEndpointHeaderSchema = z.object({
  key: z.string(),
  value: z.string(),
  location: z.enum(["headers", "query"]).optional(),
});

const DASHBOARD_ID_DESCRIPTION =
  "Target dashboard UUID. Omit to target the current Workspace route.";

const optionalDashboardId = z
  .string()
  .optional()
  .describe(DASHBOARD_ID_DESCRIPTION);

// ---------- per-command schemas ----------

export const getWorkspaceSnapshotInputSchema = z.object({});

export const listAvailableWidgetsInputSchema = z.object({
  origin: z
    .string()
    .optional()
    .describe(
      "Friendly catalog label (e.g. 'Options Activity Monitor'). Matches exactly.",
    ),
  backend_id: z
    .string()
    .optional()
    .describe("Optional backend UUID returned by manage_backends."),
});

export const getWidgetSchemaInputSchema = z.object({
  origin: z
    .string()
    .min(1)
    .describe("Friendly catalog label from list_available_widgets."),
  widget_id: z
    .string()
    .min(1)
    .describe("Widget id from list_available_widgets."),
});

export const getParamsOptionsInputSchema = z.object({
  param_options_queries: z
    .array(
      z.object({
        origin: z.string(),
        widget_id: z.string(),
        param_name: z.string(),
        data_args: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .describe(
      "One entry per param to resolve. Use only after get_widget_schema marks " +
        "the param with requires_options_lookup=true.",
    ),
});

export const readWidgetInputSchema = z.object({
  widget_uuid: z
    .string()
    .optional()
    .describe(
      "Canonical instance identifier from a workspace snapshot. Preferred over widget_id.",
    ),
  widget_id: z
    .string()
    .optional()
    .describe("Fallback widget type identifier when uuid is unknown."),
  dashboard_id: optionalDashboardId,
});

export const createWidgetInputSchema = z.object({
  origin: z
    .string()
    .min(1)
    .describe(
      "Friendly catalog label returned by list_available_widgets. Required.",
    ),
  widget_id: z
    .string()
    .min(1)
    .describe("Widget id from list_available_widgets. Required."),
  dashboard_id: optionalDashboardId,
  config: widgetConfigSchema.optional(),
});

export const updateWidgetInputSchema = z.object({
  widget_uuid: z
    .string()
    .optional()
    .describe(
      "Canonical widget instance identifier from a workspace snapshot.",
    ),
  widget_id: z
    .string()
    .optional()
    .describe("Fallback widget type identifier when uuid is unknown."),
  dashboard_id: optionalDashboardId,
  config: widgetConfigSchema.optional(),
});

export const deleteWidgetInputSchema = z.object({
  widget_uuid: z
    .string()
    .optional()
    .describe("Canonical instance identifier from a workspace snapshot."),
  widget_id: z
    .string()
    .optional()
    .describe("Fallback widget type identifier when uuid is unknown."),
  dashboard_id: optionalDashboardId,
});

export const manageDashboardInputSchema = z.object({
  operation: z
    .enum(["create", "read", "update"])
    .describe("Operation to perform on the dashboard."),
  dashboard_id: optionalDashboardId.describe(
    "Dashboard UUID. Omit on read to target the current Workspace route. Required for update.",
  ),
  name: z
    .string()
    .optional()
    .describe("Dashboard display name. Required for create and update."),
  activate: z
    .boolean()
    .optional()
    .describe(
      "On create, whether to activate the new dashboard route. Defaults true.",
    ),
});

export const updateDashboardLayoutInputSchema = z.object({
  x: z.number().describe("Grid column position (0-based)."),
  y: z.number().describe("Grid row position (0-based)."),
  w: z.number().describe("Grid width. 40 = full row."),
  h: z.number().describe("Grid height in rows."),
  widget_uuid: z
    .string()
    .optional()
    .describe(
      "Canonical widget instance identifier from a workspace snapshot.",
    ),
  widget_id: z
    .string()
    .optional()
    .describe("Fallback widget type identifier when uuid is unknown."),
  dashboard_id: optionalDashboardId,
  tab_id: z
    .string()
    .optional()
    .describe("Inner tab id to place the widget on. Omit to keep current tab."),
  min_w: z.number().optional().describe("Minimum width."),
  min_h: z.number().optional().describe("Minimum height."),
  max_w: z.number().optional().describe("Maximum width."),
  max_h: z.number().optional().describe("Maximum height."),
});

export const manageNavigationBarInputSchema = z.object({
  operation: z
    .enum(["create", "add_tabs", "remove_tabs", "rename_tabs"])
    .describe("Operation: create | add_tabs | remove_tabs | rename_tabs."),
  dashboard_id: optionalDashboardId.describe(
    "Dashboard UUID. Omit to target the current Workspace route.",
  ),
  tabs: z
    .array(z.object({ name: z.string() }))
    .optional()
    .describe(
      "Tab objects, e.g. [{name:'AAPL Analysis'}]. Required for create, add_tabs, remove_tabs. " +
        "Do not pass tab_id; it is generated as the slug of name.",
    ),
  rename_map: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Map of {oldTabId: newName} for rename_tabs operation.",
    ),
});

export const addGenerativeWidgetInputSchema = z.object({
  widget_type: z
    .enum(["note", "table", "chart", "html"])
    .describe("Generative widget kind."),
  dashboard_id: optionalDashboardId,
  data: z
    .union([z.array(z.record(z.string(), z.unknown())), z.string()])
    .nullable()
    .optional()
    .describe(
      "Widget content. note/html: plain string. table/chart: array of row objects.",
    ),
  name: z.string().optional().describe("Widget display name."),
  description: z.string().optional().describe("Widget short description."),
  chart_params: z
    .object({
      chartType: z.enum(["line", "bar", "scatter", "pie", "donut"]),
      xKey: z.string().optional(),
      yKey: z.array(z.string()).optional(),
      angleKey: z.string().optional(),
      calloutLabelKey: z.string().optional(),
    })
    .nullable()
    .optional()
    .describe(
      "Required for widget_type='chart'. line/bar/scatter need xKey + non-empty yKey; " +
        "pie/donut need angleKey + calloutLabelKey.",
    ),
  inner_tab: z
    .string()
    .optional()
    .describe(
      "Existing inner tab id to place the widget on. Does NOT create a tab.",
    ),
});

export const assignTasksToAgentsInputSchema = z.object({
  task_requests: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
        assigned_holder_url: z.string().optional(),
        assigned_agent_id: z.string().optional(),
      }),
    )
    .describe(
      "Tasks shaped like {id, description, assigned_holder_url, assigned_agent_id}.",
    ),
});

export const navigateWorkspaceInputSchema = z.object({
  operation: z
    .enum(["dashboard", "tab"])
    .describe(
      "Navigation target: 'dashboard' (full route) or 'tab' (inner tab).",
    ),
  dashboard_id: optionalDashboardId.describe(
    "Dashboard UUID. Required when operation='dashboard'.",
  ),
  tab_id: z
    .string()
    .optional()
    .describe(
      "Tab id (slug-form, e.g. 'aapl-analysis'). Required when operation='tab'.",
    ),
});

export const manageBackendsInputSchema = z.object({
  operation: z
    .enum(["list", "add", "update", "refresh", "remove"])
    .describe("Operation to perform on backends."),
  backend_id: z
    .string()
    .optional()
    .describe("Backend UUID. Required for update/refresh/remove."),
  name: z.string().optional().describe("Backend display name."),
  url: z.string().optional().describe("Backend base URL."),
  endpoint_headers: z
    .array(backendEndpointHeaderSchema)
    .optional()
    .describe(
      "Endpoint headers. location is 'headers' (default) or 'query'.",
    ),
  validate_widgets: z
    .boolean()
    .optional()
    .describe(
      "Whether to surface a warning if widgets fail to load. Defaults true on add.",
    ),
  is_openbb_platform: z
    .boolean()
    .optional()
    .describe("Mark as an OpenBB Platform backend."),
});

export const manageAppsInputSchema = z.object({
  operation: z
    .enum(["list", "read", "instantiate"])
    .describe("Operation: list | read | instantiate."),
  backend_id: z
    .string()
    .describe(
      "Backend UUID. Required. Use manage_backends operation='list' to discover.",
    ),
  app_name: z
    .string()
    .optional()
    .describe(
      "App display name. Provide app_name or template_id for read/instantiate.",
    ),
  template_id: z
    .string()
    .optional()
    .describe(
      "Template UUID. Provide app_name or template_id for read/instantiate.",
    ),
  dashboard_name: z
    .string()
    .optional()
    .describe(
      "Override dashboard name on instantiate (defaults to app's name).",
    ),
  activate: z
    .boolean()
    .optional()
    .describe(
      "On instantiate, route the browser to the new dashboard. Defaults true.",
    ),
});

// ---------- registry ----------

export interface WorkspaceBridgeCommandSpec {
  name: string;
  description: string;
  inputSchema: z.ZodObject<Record<string, z.ZodTypeAny>>;
}

export const WORKSPACE_BRIDGE_COMMANDS: readonly WorkspaceBridgeCommandSpec[] = [
  {
    name: "get_workspace_snapshot",
    description:
      "Request a fresh OpenBB Workspace snapshot from the connected browser. " +
      "Call first when you need current dashboard state, dashboard identifiers, or skill identifiers. " +
      "Use list_available_widgets, get_widget_schema, and manage_dashboard for deeper follow-up inspection.",
    inputSchema: getWorkspaceSnapshotInputSchema,
  },
  {
    name: "list_available_widgets",
    description:
      "List widgets available to the current Workspace session. " +
      "Returns deterministic widget identities for later get_widget_schema and create_widget calls. " +
      "origin matches the friendly catalog label exactly; backend_id is optional and must be an exact backend UUID from manage_backends. " +
      "Without filters the entire catalog is returned (hundreds of widgets) — prefer a filter when you know the source. " +
      "Generative-only note widgets like rich_note are excluded; use add_generative_widget for those.",
    inputSchema: listAvailableWidgetsInputSchema,
  },
  {
    name: "get_widget_schema",
    description:
      "Fetch the exact schema for one available widget. " +
      "Returns deterministic params and UI inputs to use in subsequent create_widget / update_widget calls. " +
      "Requires origin and widget_id from list_available_widgets — caller must select before calling.",
    inputSchema: getWidgetSchemaInputSchema,
  },
  {
    name: "get_params_options",
    description:
      "Fetch parameter options for one or more widget input queries. " +
      "Use only after get_widget_schema marks a param with requires_options_lookup=true.",
    inputSchema: getParamsOptionsInputSchema,
  },
  {
    name: "read_widget",
    description:
      "Read one widget from the active dashboard. " +
      "widget_uuid is the canonical instance identifier; widget_id is a fallback when only the type is known.",
    inputSchema: readWidgetInputSchema,
  },
  {
    name: "add_widget_to_dashboard",
    description:
      "Create one widget on a target dashboard. Requires origin and widget_id. " +
      "Omit dashboard_id for the current dashboard. " +
      "Creates on the current tab; navigate_workspace to the desired tab first for tab-scoped placement. " +
      "Use list_available_widgets and get_widget_schema when you need catalog identities or config params. " +
      "Do not use this for rich_note; use add_generative_widget with widget_type='note'.",
    inputSchema: createWidgetInputSchema,
  },
  {
    name: "update_widget_in_dashboard",
    description:
      "Update one widget's config on a target dashboard. " +
      "Handles 'update/set/change <param> to <value>' requests; the user may name a target widget by display name. " +
      "Call only after identifying the target widget instances and confirming they expose the parameter being changed. " +
      "Do not guess enum/dropdown values; call get_widget_schema and get_params_options when needed, then pass option values, not labels. " +
      "For plain string values, preserve the user's literal casing unless schema/options require otherwise. " +
      "Layout fields (x/y/w/h/grid_data/inner_tab/etc.) are rejected — use update_dashboard_layout for those.",
    inputSchema: updateWidgetInputSchema,
  },
  {
    name: "delete_widget",
    description:
      "Delete a Workspace widget from a dashboard. " +
      "Provide widget_uuid (preferred) or widget_id. dashboard_id defaults to the current route.",
    inputSchema: deleteWidgetInputSchema,
  },
  {
    name: "manage_dashboard",
    description:
      "Create, read, or update one Workspace dashboard. " +
      "create requires name. read uses current route if dashboard_id omitted. update requires dashboard_id and name.",
    inputSchema: manageDashboardInputSchema,
  },
  {
    name: "update_dashboard_layout",
    description:
      "Move or resize one widget on the active dashboard. " +
      "Requires x/y/w/h grid coordinates. Optional min_w/min_h/max_w/max_h size constraints.",
    inputSchema: updateDashboardLayoutInputSchema,
  },
  {
    name: "manage_navigation_bar",
    description:
      "Create or mutate the Workspace navigation bar (tabs). " +
      "create / add_tabs / remove_tabs use tabs:[{name}]. rename_tabs uses rename_map:{oldId:newName}. " +
      "tab_id is generated as the slug of name; navigate to that slug after add_tabs before placing content.",
    inputSchema: manageNavigationBarInputSchema,
  },
  {
    name: "add_generative_widget",
    description:
      "Create a generative widget (note, table, chart, or html) with inline data on a dashboard. " +
      "chart requires chart_params (line/bar/scatter need xKey + non-empty yKey; pie/donut need angleKey + calloutLabelKey).",
    inputSchema: addGenerativeWidgetInputSchema,
  },
  {
    name: "assign_tasks_to_agents",
    description:
      "Assign tasks to configured external Workspace agents. " +
      "task_requests items shaped like {id, description, assigned_holder_url, assigned_agent_id}.",
    inputSchema: assignTasksToAgentsInputSchema,
  },
  {
    name: "navigate_workspace",
    description:
      "Navigate the Workspace browser to an existing dashboard or inner tab. " +
      "operation='dashboard' requires dashboard_id; operation='tab' requires tab_id.",
    inputSchema: navigateWorkspaceInputSchema,
  },
  {
    name: "manage_backends",
    description:
      "Manage Workspace data backends (the connections that power widgets). " +
      "list / add / update / refresh / remove. add requires name and url. update/refresh/remove require backend_id.",
    inputSchema: manageBackendsInputSchema,
  },
  {
    name: "manage_apps",
    description:
      "List, read, or instantiate apps from a Workspace data backend. Requires backend_id. " +
      "read/instantiate require app_name or template_id. instantiate creates a fresh dashboard from the app template.",
    inputSchema: manageAppsInputSchema,
  },
] as const;

export const WORKSPACE_BRIDGE_COMMAND_NAMES: ReadonlySet<string> = new Set(
  WORKSPACE_BRIDGE_COMMANDS.map((c) => c.name),
);

/**
 * Path-B bridge-mount tool names that do NOT appear in WORKSPACE_BRIDGE_COMMANDS
 * but still duplicate an agent-owned path:
 *   - `update_widget_layout` — the mcp-server mount's name for the
 *     `update_dashboard_layout` wire command (mcp-server/src/bridge/wire.ts).
 *   - `get_widget_data` / `get_skill_content` — bridge commands with bespoke
 *     agent round-trip paths (widget tier resolution, skill payload injection),
 *     deliberately excluded from the table above.
 * The MCP factory drops user-supplied wrappers with these names so they never
 * double-register against the native tools — and so `update_widget_layout`
 * cannot expose a dashboard-mutation path while generative UI is disabled.
 */
export const BRIDGE_MOUNT_EXTRA_NAMES: ReadonlySet<string> = new Set([
  "update_widget_layout",
  // WebSocket-companion wire names for what the SSE agent now registers as
  // `update_widget_in_dashboard` / `add_widget_to_dashboard`. Kept here so the
  // MCP factory still dedups the companion's wrappers after the SSE-side rename.
  "update_widget",
  "create_widget",
  "get_widget_data",
  "get_skill_content",
]);

export function isWorkspaceBridgeCommand(name: string): boolean {
  return WORKSPACE_BRIDGE_COMMAND_NAMES.has(name);
}

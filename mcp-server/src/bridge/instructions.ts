/**
 * Tool description constants — verbatim port of workspace_mcp/server.py:39-166.
 *
 * Each tool composes its description from a `summary` plus zero or more of
 * these guidance snippets, exactly mirroring the Python `describe_tool` helper.
 * Keep these strings byte-compatible with the Python source so any LLM that
 * learned the workspace-mcp surface continues to behave identically.
 */

export const USAGE_SUMMARY =
  "Use snake_case payloads. Start with get_workspace_snapshot to discover valid " +
  "dashboard_id, dashboard_composition, and skills from the live Workspace " +
  "session. Use list_available_widgets and get_widget_schema for widget library " +
  "discovery. Do not invent identifiers.";

export const WIDGET_SCHEMA_GUIDANCE =
  "Use list_available_widgets to enumerate candidates and get_widget_schema to " +
  "inspect one exact widget contract before creating it. get_widget_schema " +
  "includes grid_data defaults and min/max layout constraints when the widget " +
  "definition provides them. If a param returns requires_options_lookup=true, " +
  "call get_params_options before create_widget or update_widget and do not " +
  "invent values for that param. Always pass the origin returned by " +
  "list_available_widgets; blank origin means the catalog is invalid.";

export const CREATE_WIDGET_GUIDANCE =
  "For create_widget, pass origin as the exact catalog value returned by " +
  "list_available_widgets. Pass data_args_json and ui_args_json as JSON " +
  "object strings when config values are needed.";

export const DATA_SOURCE_SHAPE =
  "Pass origin, widget_id, and data_args_json for one data source. " +
  "data_args_json and ssm_request_json must be JSON object strings.";

export const PARAM_OPTIONS_SHAPE =
  "Pass origin, widget_id, param_name, and optional data_args_json for one " +
  "parameter option query. Only call get_params_options after get_widget_schema " +
  "shows the exact param has requires_options_lookup=true. Use the exact " +
  "paramName from the schema as param_name. data_args_json must be a JSON " +
  "object string with the values required by options_lookup_params when present.";

export const GENERATIVE_WIDGET_GUIDANCE =
  "For add_generative_widget: note and html require data_json as the raw text " +
  "or HTML content string; JSON string literals are also accepted. table requires " +
  "data_json as a JSON array of objects. chart requires data_json as a JSON " +
  "array of objects plus chart_params_json as a JSON object with chartType, " +
  "xKey, and non-empty yKey. " +
  "Use widget_type='note' for rich text notes such as rich_note. " +
  "The response includes widget_uuid; use that UUID for layout changes. " +
  "The inner_tab argument only places the new widget on an existing navigation tab; " +
  "it does not create a tab. To put a generated widget on a new tab, first call " +
  'manage_navigation_bar operation="add_tabs" with tabs_json such as [{"name":"AAPL Analysis"}], ' +
  "then navigate_workspace to the generated slug tab_id such as aapl-analysis, " +
  "then call add_generative_widget without inner_tab so it lands on the active tab.";

export const WIDGET_INSTANCE_GUIDANCE =
  "Prefer widget_uuid for read, update, and delete. widget_id is only a fallback " +
  "when exactly one matching widget instance exists on the target dashboard. " +
  "Never use a widget title or generic widget type such as rich_note as a layout " +
  "identifier.";

export const DASHBOARD_TARGETING_GUIDANCE =
  "Resolve dashboard_id from current_dashboard_uuid before each write. Every " +
  "successful command result includes session_context.current_dashboard_uuid " +
  "(and current_tab_id) — reuse that from the previous response instead of " +
  "calling get_workspace_snapshot again. Use get_workspace_snapshot only on " +
  "the first call, or after a navigation step that may have invalidated the " +
  "tracked context. Never match dashboards by name: duplicates with identical " +
  'names are common. "This dashboard" means the current route; resolve via ' +
  "current_dashboard_uuid, not title. Omitting dashboard_id also targets the " +
  "current route.";

export const EXISTING_DASHBOARD_GUIDANCE =
  "These tools operate on an existing dashboard only. They do not create dashboards.";

export const CREATE_DASHBOARD_GUIDANCE =
  "Use manage_dashboard with operation='create' to create a dashboard first. " +
  "By default it activates the new dashboard route so follow-up snapshot and " +
  "widget commands target it.";

export const LAYOUT_GUIDANCE =
  "Visible placement is controlled by dashboard composition, not update_widget. " +
  "Use manage_dashboard operation='read' or get_workspace_snapshot.dashboard_composition " +
  "to inspect tabs and layout, then use update_widget_layout for x, y, w, h, and tab_id. " +
  "The grid is 40 columns wide: full width is w=40, half width is w=20, one quarter " +
  "is w=10. Typical minimums are about min_w=8 and min_h=4. If a navigation_bar is " +
  "present it usually occupies y=0 with h=2, so the first content row usually starts " +
  "at y=2.";

export const NAVIGATION_BAR_GUIDANCE =
  "manage_navigation_bar manages the navigation_bar widget inside an existing dashboard. " +
  "If the dashboard does not already have a navigation_bar widget, call create first. " +
  "Its create operation creates or initializes navigation tabs on that dashboard; it does not create a dashboard. " +
  "For create, add_tabs, and remove_tabs, tabs_json must be a JSON array of objects, " +
  'for example [{"name":"AAPL Analysis"}]. Each object must use only the key name, not tab_id or tab_name. ' +
  'Do not pass a JSON array of strings such as ["AAPL Analysis"].';

export const DISCOVERY_WORKFLOW =
  "Recommended workflow: call get_workspace_snapshot first, manage_dashboard " +
  "with operation='create' when you need a fresh dashboard, call " +
  "list_available_widgets to enumerate candidate widgets, call " +
  "get_widget_schema for the exact widget contract, call " +
  "get_params_options when a schema field returns requires_options_lookup=true, then call " +
  "create_widget with explicit dashboard_id, origin, widget_id, data_args_json, " +
  "and ui_args_json. list_available_widgets only returns the deterministic plain-create " +
  "subset; widgets that still need runtime-only bootstrap are intentionally " +
  "excluded. Do not use create_widget for rich_note; use add_generative_widget " +
  "with widget_type='note'. Use manage_dashboard operation='read' or " +
  "get_workspace_snapshot.dashboard_composition " +
  "to inspect visible layout and update_widget_layout to move or resize " +
  "widgets. When asked to put content on a new tab, create the tab first with " +
  "manage_navigation_bar add_tabs using tabs_json objects with only name, then " +
  "navigate_workspace to the generated slug tab_id, then create the widget without " +
  "inner_tab or move an existing widget with update_widget_layout. Do not assume " +
  "add_generative_widget inner_tab creates the tab.";

export const SERVER_INSTRUCTIONS = [
  "Expose the active OpenBB Workspace browser session as MCP tools.",
  "All tools require a running local Workspace browser bridge.",
  USAGE_SUMMARY,
  WIDGET_SCHEMA_GUIDANCE,
  CREATE_WIDGET_GUIDANCE,
  DATA_SOURCE_SHAPE,
  PARAM_OPTIONS_SHAPE,
  GENERATIVE_WIDGET_GUIDANCE,
  WIDGET_INSTANCE_GUIDANCE,
  DASHBOARD_TARGETING_GUIDANCE,
  CREATE_DASHBOARD_GUIDANCE,
  LAYOUT_GUIDANCE,
  DISCOVERY_WORKFLOW,
  "Provide dashboard_id explicitly when operating on a dashboard other than " +
    "the current Workspace route.",
].join(" ");

export function describeTool(summary: string, ...notes: string[]): string {
  return [summary, ...notes].filter(Boolean).join(" ");
}

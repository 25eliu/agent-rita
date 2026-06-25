/**
 * Workspace command wire schemas — Zod source of truth.
 *
 * Mirrors WorkspaceCommand discriminated union from workspace_mcp/workspace_mcp/models.py:359-379.
 * Output JSON envelopes are byte-compat with Theo's FE bridge protocol.
 *
 * Note: Pydantic's `validation_alias=AliasChoices(...)` (e.g. origin|backend_name)
 * affects parsing of inbound payloads. Our outbound (server → browser) uses
 * canonical Pydantic field names. Inbound aliases not handled in PoC; add
 * `.transform()` if/when an LLM-facing surface needs them.
 */

import { z } from "zod";
import { BridgeErrorSchema } from "./types";

export const WorkspaceWidgetConfigSchema = z.object({
  data_args: z.record(z.string(), z.unknown()).nullable().optional(),
  ui_args: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type WorkspaceWidgetConfig = z.infer<typeof WorkspaceWidgetConfigSchema>;

export const BackendEndpointHeaderSchema = z.object({
  key: z.string(),
  value: z.string(),
  location: z.enum(["headers", "query"]).default("headers"),
});

const baseCommand = {
  request_id: z.string().nullable().optional(),
};

// 18 command variants — keep ordering aligned with models.py:359-379

export const GetWidgetDataCommandSchema = z.object({
  command: z.literal("get_widget_data"),
  ...baseCommand,
  data_sources: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const ListAvailableWidgetsCommandSchema = z.object({
  command: z.literal("list_available_widgets"),
  ...baseCommand,
  origin: z.string().nullable().optional(),
  backend_id: z.string().nullable().optional(),
});

export const GetWidgetSchemaCommandSchema = z.object({
  command: z.literal("get_widget_schema"),
  ...baseCommand,
  origin: z.string().nullable().optional(),
  widget_id: z.string(),
});

export const GetParamOptionsCommandSchema = z.object({
  command: z.literal("get_params_options"),
  ...baseCommand,
  param_options_queries: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const ReadWidgetCommandSchema = z.object({
  command: z.literal("read_widget"),
  ...baseCommand,
  dashboard_id: z.string().nullable().optional(),
  widget_uuid: z.string().nullable().optional(),
  widget_id: z.string().nullable().optional(),
});

export const CreateWidgetCommandSchema = z.object({
  command: z.literal("create_widget"),
  ...baseCommand,
  dashboard_id: z.string().nullable().optional(),
  backend_name: z.string(),
  widget_id: z.string(),
  config: WorkspaceWidgetConfigSchema.nullable().optional(),
});

export const UpdateWidgetCommandSchema = z.object({
  command: z.literal("update_widget"),
  ...baseCommand,
  dashboard_id: z.string().nullable().optional(),
  widget_uuid: z.string().nullable().optional(),
  widget_id: z.string().nullable().optional(),
  config: WorkspaceWidgetConfigSchema,
});

export const DeleteWidgetCommandSchema = z.object({
  command: z.literal("delete_widget"),
  ...baseCommand,
  dashboard_id: z.string().nullable().optional(),
  widget_uuid: z.string().nullable().optional(),
  widget_id: z.string().nullable().optional(),
});

export const ManageDashboardCommandSchema = z.object({
  command: z.literal("manage_dashboard"),
  ...baseCommand,
  operation: z.enum(["create", "read", "update"]),
  dashboard_id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  activate: z.boolean().nullable().optional(),
});

// Note: tool name is `update_widget_layout` but wire command name is
// `update_dashboard_layout` — matches Pydantic `models.py:259`.
export const UpdateDashboardLayoutCommandSchema = z.object({
  command: z.literal("update_dashboard_layout"),
  ...baseCommand,
  dashboard_id: z.string().nullable().optional(),
  widget_uuid: z.string().nullable().optional(),
  widget_id: z.string().nullable().optional(),
  tab_id: z.string().nullable().optional(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  min_w: z.number().nullable().optional(),
  min_h: z.number().nullable().optional(),
  max_w: z.number().nullable().optional(),
  max_h: z.number().nullable().optional(),
});

export const NavigateWorkspaceCommandSchema = z.object({
  command: z.literal("navigate_workspace"),
  ...baseCommand,
  operation: z.enum(["dashboard", "tab"]),
  dashboard_id: z.string().nullable().optional(),
  tab_id: z.string().nullable().optional(),
});

export const ManageNavigationBarCommandSchema = z.object({
  command: z.literal("manage_navigation_bar"),
  ...baseCommand,
  dashboard_id: z.string().nullable().optional(),
  operation: z.enum(["create", "add_tabs", "remove_tabs", "rename_tabs"]),
  tabs: z.array(z.record(z.string(), z.unknown())).default([]),
  rename_map: z.record(z.string(), z.string()).default({}),
});

export const AddGenerativeWidgetCommandSchema = z.object({
  command: z.literal("add_generative_widget"),
  ...baseCommand,
  dashboard_id: z.string().nullable().optional(),
  widget_type: z.enum(["note", "table", "chart", "html"]),
  data: z
    .union([z.array(z.record(z.string(), z.unknown())), z.string()])
    .nullable()
    .optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  chart_params: z.record(z.string(), z.unknown()).nullable().optional(),
  inner_tab: z.string().nullable().optional(),
});

export const AssignTasksToAgentsCommandSchema = z.object({
  command: z.literal("assign_tasks_to_agents"),
  ...baseCommand,
  task_requests: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const GetSkillContentCommandSchema = z.object({
  command: z.literal("get_skill_content"),
  ...baseCommand,
  slug: z.string(),
  reason: z.string().nullable().optional(),
});

export const GetWorkspaceSnapshotCommandSchema = z.object({
  command: z.literal("get_workspace_snapshot"),
  ...baseCommand,
});

export const ManageBackendsCommandSchema = z.object({
  command: z.literal("manage_backends"),
  ...baseCommand,
  operation: z.enum(["list", "add", "update", "refresh", "remove"]),
  backend_id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  endpoint_headers: z.array(BackendEndpointHeaderSchema).nullable().optional(),
  validate_widgets: z.boolean().nullable().optional(),
  is_openbb_platform: z.boolean().nullable().optional(),
});

export const ManageAppsCommandSchema = z.object({
  command: z.literal("manage_apps"),
  ...baseCommand,
  operation: z.enum(["list", "read", "instantiate"]),
  backend_id: z.string(),
  app_name: z.string().nullable().optional(),
  template_id: z.string().nullable().optional(),
  dashboard_name: z.string().nullable().optional(),
  activate: z.boolean().nullable().optional(),
});

export const WorkspaceCommandSchema = z.discriminatedUnion("command", [
  GetWidgetDataCommandSchema,
  ListAvailableWidgetsCommandSchema,
  GetWidgetSchemaCommandSchema,
  GetParamOptionsCommandSchema,
  ReadWidgetCommandSchema,
  CreateWidgetCommandSchema,
  UpdateWidgetCommandSchema,
  DeleteWidgetCommandSchema,
  ManageDashboardCommandSchema,
  UpdateDashboardLayoutCommandSchema,
  NavigateWorkspaceCommandSchema,
  ManageNavigationBarCommandSchema,
  AddGenerativeWidgetCommandSchema,
  AssignTasksToAgentsCommandSchema,
  GetSkillContentCommandSchema,
  GetWorkspaceSnapshotCommandSchema,
  ManageBackendsCommandSchema,
  ManageAppsCommandSchema,
]);
export type WorkspaceCommand = z.infer<typeof WorkspaceCommandSchema>;

export const WorkspaceCommandResultSchema = z.object({
  ok: z.boolean(),
  command: z.string(),
  request_id: z.string().nullable().optional(),
  message: z.string(),
  data: z.unknown().nullable().optional(),
  error: BridgeErrorSchema.nullable().optional(),
});
export type WorkspaceCommandResult = z.infer<
  typeof WorkspaceCommandResultSchema
>;

/**
 * Snapshot envelope returned by `get_workspace_snapshot`.
 *
 * Mirrors workspace_mcp/models.py:85-103. `workspace_state` and `tools[]`
 * are typed loosely (z.unknown() / record) — strict validation would require
 * porting openbb_ai.models.WorkspaceState + AgentTool, which is out of PoC
 * scope. Envelope-level shape is enforced; deep validation is deferred.
 */
export const WorkspaceSnapshotSchema = z.object({
  generated_at: z.number().int(),
  workspace_state: z.unknown().nullable().optional(),
  workspace_options: z.array(z.string()).default([]),
  dashboards: z.array(z.record(z.string(), z.unknown())).default([]),
  dashboard_composition: z.record(z.string(), z.unknown()).nullable().optional(),
  widgets: z
    .record(z.string(), z.array(z.record(z.string(), z.unknown())))
    .default({ primary: [], secondary: [], extra: [] }),
  context: z.array(z.record(z.string(), z.unknown())).default([]),
  artifacts: z.array(z.record(z.string(), z.unknown())).default([]),
  files: z.array(z.record(z.string(), z.unknown())).default([]),
  tools: z.array(z.record(z.string(), z.unknown())).default([]),
  skills: z.array(z.record(z.string(), z.unknown())).default([]),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

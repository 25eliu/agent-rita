/**
 * create_widget — place a catalog widget on a target dashboard.
 *
 * Mirrors workspace_mcp/server.py:725-766. Rejects rich_note (must use
 * add_generative_widget). config built lazily so omitted args don't ship
 * an empty {data_args:null,ui_args:null} payload.
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";
import {
  invalidRequestItem,
  isGenerativeOnlyWidget,
} from "../../bridge/validators";
import { parseJsonObject, JsonArgumentError } from "../../bridge/json-args";
import {
  describeTool,
  DASHBOARD_TARGETING_GUIDANCE,
  EXISTING_DASHBOARD_GUIDANCE,
  CREATE_WIDGET_GUIDANCE,
} from "../../bridge/instructions";

export const createWidgetSchema = {
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
  dashboard_id: z
    .string()
    .optional()
    .describe(
      "Target dashboard UUID. Omit to target the current Workspace route. " +
        "Resolve from session_context.current_dashboard_uuid in the prior response.",
    ),
  data_args_json: z
    .string()
    .optional()
    .describe(
      "JSON object string. Widget data inputs from get_widget_schema params.",
    ),
  ui_args_json: z
    .string()
    .optional()
    .describe(
      "JSON object string. Widget UI inputs from get_widget_schema. " +
        "Do not include layout fields (x/y/w/h/grid_data) — use update_widget_layout.",
    ),
} as const;

export const createWidgetDescription = describeTool(
  "Create one widget on a target dashboard.",
  "Requires origin and widget_id.",
  DASHBOARD_TARGETING_GUIDANCE,
  EXISTING_DASHBOARD_GUIDANCE,
  "Use list_available_widgets and get_widget_schema first.",
  CREATE_WIDGET_GUIDANCE,
  "Do not use this for rich_note; use add_generative_widget with widget_type='note'.",
);

export async function createWidgetHandler(args: {
  origin: string;
  widget_id: string;
  dashboard_id?: string;
  data_args_json?: string;
  ui_args_json?: string;
}): Promise<{ content: ContentItem[] }> {
  if (isGenerativeOnlyWidget(args.widget_id)) {
    return {
      content: [
        invalidRequestItem(
          "create_widget does not support 'rich_note'. Use add_generative_widget with widget_type='note' instead.",
        ),
      ],
    };
  }

  let dataArgs: Record<string, unknown>;
  let uiArgs: Record<string, unknown>;
  try {
    dataArgs = parseJsonObject("create_widget", "data_args_json", args.data_args_json);
    uiArgs = parseJsonObject("create_widget", "ui_args_json", args.ui_args_json);
  } catch (err) {
    if (err instanceof JsonArgumentError) {
      return { content: [err.toContentItem()] };
    }
    throw err;
  }

  const dataArgsValue = Object.keys(dataArgs).length > 0 ? dataArgs : null;
  const uiArgsValue = Object.keys(uiArgs).length > 0 ? uiArgs : null;
  const config =
    dataArgsValue !== null || uiArgsValue !== null
      ? { data_args: dataArgsValue, ui_args: uiArgsValue }
      : null;

  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "create_widget",
    dashboard_id: args.dashboard_id ?? null,
    backend_name: args.origin,
    widget_id: args.widget_id,
    config,
  });
  return { content };
}

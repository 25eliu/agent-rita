/**
 * update_widget — change widget config (not layout).
 *
 * Mirrors workspace_mcp/server.py:772-808. Rejects layout-shaped ui_args
 * (x/y/w/h/grid_data/etc.) so callers route those to update_widget_layout.
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";
import { invalidRequestItem, hasLayoutUiArgs } from "../../bridge/validators";
import { parseJsonObject, JsonArgumentError } from "../../bridge/json-args";
import {
  describeTool,
  WIDGET_INSTANCE_GUIDANCE,
  LAYOUT_GUIDANCE,
  DASHBOARD_TARGETING_GUIDANCE,
} from "../../bridge/instructions";

export const updateWidgetSchema = {
  widget_uuid: z.string().optional().describe(
    "Canonical widget instance identifier from a workspace snapshot.",
  ),
  widget_id: z.string().optional().describe(
    "Fallback widget type identifier when uuid is unknown.",
  ),
  dashboard_id: z.string().optional().describe(
    "Target dashboard UUID. Omit to target the current Workspace route.",
  ),
  data_args_json: z.string().optional().describe(
    "JSON object string of widget data inputs.",
  ),
  ui_args_json: z.string().optional().describe(
    "JSON object string of widget UI inputs. Layout fields rejected — use update_widget_layout.",
  ),
} as const;

export const updateWidgetDescription = describeTool(
  "Update one widget's config on a target dashboard.",
  WIDGET_INSTANCE_GUIDANCE,
  DASHBOARD_TARGETING_GUIDANCE,
  LAYOUT_GUIDANCE,
);

export async function updateWidgetHandler(args: {
  widget_uuid?: string;
  widget_id?: string;
  dashboard_id?: string;
  data_args_json?: string;
  ui_args_json?: string;
}): Promise<{ content: ContentItem[] }> {
  let dataArgs: Record<string, unknown>;
  let uiArgs: Record<string, unknown>;
  try {
    dataArgs = parseJsonObject("update_widget", "data_args_json", args.data_args_json);
    uiArgs = parseJsonObject("update_widget", "ui_args_json", args.ui_args_json);
  } catch (err) {
    if (err instanceof JsonArgumentError) {
      return { content: [err.toContentItem()] };
    }
    throw err;
  }

  if (hasLayoutUiArgs(uiArgs)) {
    return {
      content: [
        invalidRequestItem(
          "update_widget does not accept layout fields (x/y/w/h/min_w/grid_data/inner_tab/etc.). " +
            "Use update_widget_layout for those.",
        ),
      ],
    };
  }

  // Python's required_widget_config always builds a config object even when
  // both args are empty (server.py:799-802). Match that for wire parity.
  const config = {
    data_args: Object.keys(dataArgs).length > 0 ? dataArgs : null,
    ui_args: Object.keys(uiArgs).length > 0 ? uiArgs : null,
  };

  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "update_widget",
    widget_uuid: args.widget_uuid ?? null,
    widget_id: args.widget_id ?? null,
    dashboard_id: args.dashboard_id ?? null,
    config,
  });
  return { content };
}

/**
 * update_widget_layout — move/resize one widget on the active dashboard.
 *
 * Mirrors workspace_mcp/server.py:816-851. Note: tool name is
 * `update_widget_layout` but the wire command is `update_dashboard_layout`
 * (models.py:259) — preserved for byte-compat.
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";
import {
  describeTool,
  LAYOUT_GUIDANCE,
  WIDGET_INSTANCE_GUIDANCE,
  DASHBOARD_TARGETING_GUIDANCE,
} from "../../bridge/instructions";

export const updateWidgetLayoutSchema = {
  x: z.number().describe("Grid column position (0-based)."),
  y: z.number().describe("Grid row position (0-based)."),
  w: z.number().describe("Grid width. 40 = full row."),
  h: z.number().describe("Grid height in rows."),
  widget_uuid: z.string().optional().describe(
    "Canonical widget instance identifier from a workspace snapshot.",
  ),
  widget_id: z.string().optional().describe(
    "Fallback widget type identifier when uuid is unknown.",
  ),
  dashboard_id: z.string().optional().describe(
    "Target dashboard UUID. Omit to target the current Workspace route.",
  ),
  tab_id: z.string().optional().describe(
    "Inner tab id to place the widget on. Omit to keep current tab.",
  ),
  min_w: z.number().optional().describe("Minimum width."),
  min_h: z.number().optional().describe("Minimum height."),
  max_w: z.number().optional().describe("Maximum width."),
  max_h: z.number().optional().describe("Maximum height."),
} as const;

export const updateWidgetLayoutDescription = describeTool(
  "Move or resize one widget on the active dashboard.",
  WIDGET_INSTANCE_GUIDANCE,
  DASHBOARD_TARGETING_GUIDANCE,
  LAYOUT_GUIDANCE,
);

export async function updateWidgetLayoutHandler(args: {
  x: number;
  y: number;
  w: number;
  h: number;
  widget_uuid?: string;
  widget_id?: string;
  dashboard_id?: string;
  tab_id?: string;
  min_w?: number;
  min_h?: number;
  max_w?: number;
  max_h?: number;
}): Promise<{ content: ContentItem[] }> {
  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "update_dashboard_layout",
    dashboard_id: args.dashboard_id ?? null,
    widget_uuid: args.widget_uuid ?? null,
    widget_id: args.widget_id ?? null,
    tab_id: args.tab_id ?? null,
    x: args.x,
    y: args.y,
    w: args.w,
    h: args.h,
    min_w: args.min_w ?? null,
    min_h: args.min_h ?? null,
    max_w: args.max_w ?? null,
    max_h: args.max_h ?? null,
  });
  return { content };
}

/**
 * delete_widget — remove one widget from a dashboard.
 *
 * Pure pass-through to the connected browser bridge. Mirrors
 * workspace_mcp/server.py:857.
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";

export const deleteWidgetSchema = {
  widget_uuid: z
    .string()
    .optional()
    .describe("Canonical instance identifier from a workspace snapshot."),
  widget_id: z
    .string()
    .optional()
    .describe("Fallback widget type identifier when uuid is unknown."),
  dashboard_id: z
    .string()
    .optional()
    .describe(
      "Target dashboard UUID. Omit to target the current Workspace route.",
    ),
} as const;

export const deleteWidgetDescription =
  "Delete a Workspace widget from a dashboard. " +
  "Provide widget_uuid (preferred) or widget_id. dashboard_id defaults to the current route.";

export async function deleteWidgetHandler(args: {
  widget_uuid?: string;
  widget_id?: string;
  dashboard_id?: string;
}): Promise<{ content: ContentItem[] }> {
  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "delete_widget",
    widget_uuid: args.widget_uuid ?? null,
    widget_id: args.widget_id ?? null,
    dashboard_id: args.dashboard_id ?? null,
  });
  return { content };
}

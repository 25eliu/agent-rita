/**
 * read_widget — read one widget's current payload from the active dashboard.
 *
 * Pure pass-through to the connected browser bridge. Mirrors
 * workspace_mcp/server.py:694.
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";

export const readWidgetSchema = {
  widget_uuid: z
    .string()
    .optional()
    .describe(
      "Canonical instance identifier from a workspace snapshot. Preferred over widget_id.",
    ),
  widget_id: z
    .string()
    .optional()
    .describe(
      "Fallback widget type identifier. Browser resolves the active instance.",
    ),
  dashboard_id: z
    .string()
    .optional()
    .describe(
      "Target dashboard UUID. Omit to target the current Workspace route.",
    ),
} as const;

export const readWidgetDescription =
  "Read one widget from the active dashboard. " +
  "widget_uuid is the canonical instance identifier; widget_id is a fallback when only the type is known.";

export async function readWidgetHandler(args: {
  widget_uuid?: string;
  widget_id?: string;
  dashboard_id?: string;
}): Promise<{ content: ContentItem[] }> {
  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "read_widget",
    widget_uuid: args.widget_uuid ?? null,
    widget_id: args.widget_id ?? null,
    dashboard_id: args.dashboard_id ?? null,
  });
  return { content };
}

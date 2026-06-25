/**
 * get_widget_schema — fetch one widget's params + UI schema.
 *
 * Pre-validates that origin and widget_id are present (mirrors
 * workspace_mcp/server.py:581-585 invalid_request guard).
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";

export const getWidgetSchemaSchema = {
  origin: z
    .string()
    .min(1)
    .describe("Friendly catalog label from list_available_widgets."),
  widget_id: z
    .string()
    .min(1)
    .describe("Widget id from list_available_widgets."),
} as const;

export const getWidgetSchemaDescription =
  "Fetch the exact schema for one available widget. " +
  "Returns deterministic params and UI inputs to use in subsequent create_widget / update_widget calls. " +
  "Requires origin and widget_id from list_available_widgets — caller must select before calling.";

export async function getWidgetSchemaHandler(args: {
  origin: string;
  widget_id: string;
}): Promise<{ content: ContentItem[] }> {
  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "get_widget_schema",
    origin: args.origin,
    widget_id: args.widget_id,
  });
  return { content };
}

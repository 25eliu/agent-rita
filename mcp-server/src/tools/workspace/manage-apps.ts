/**
 * manage_apps — list/read/instantiate apps from a backend's apps.json.
 *
 * Mirrors workspace_mcp/server.py:1143-1179.
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";
import { invalidRequestItem } from "../../bridge/validators";
import { describeTool } from "../../bridge/instructions";

export const manageAppsSchema = {
  operation: z
    .enum(["list", "read", "instantiate"])
    .describe("Operation: list | read | instantiate."),
  backend_id: z.string().describe(
    "Backend UUID. Required. Use manage_backends operation='list' to discover.",
  ),
  app_name: z.string().optional().describe(
    "App display name. Provide app_name or template_id for read/instantiate.",
  ),
  template_id: z.string().optional().describe(
    "Template UUID. Provide app_name or template_id for read/instantiate.",
  ),
  dashboard_name: z.string().optional().describe(
    "Override dashboard name on instantiate (defaults to app's name).",
  ),
  activate: z.boolean().optional().describe(
    "On instantiate, route the browser to the new dashboard. Defaults true.",
  ),
} as const;

export const manageAppsDescription = describeTool(
  "List, read, or instantiate apps from a Workspace data backend.",
  "Apps are full dashboard templates declared in the backend's apps.json: " +
    "they bundle tabs, widget layouts, parameter groups, and suggested prompts. " +
    "Instantiating one is the programmatic equivalent of clicking an app in the gallery.",
  "Requires operation from {list, read, instantiate} and backend_id. " +
    "Use manage_backends operation='list' to discover backend_id values and app_count.",
  "For list, returns each app with name, template_id, description, tab_count, " +
    "group_count, prompt_count, and allow_customization.",
  "For read, requires app_name (or template_id); returns the full app definition " +
    "including tabs with layouts, parameter groups, and suggested prompts.",
  "For instantiate, requires app_name (or template_id); creates a fresh dashboard " +
    "from the app template and returns its dashboard_id. Pass that dashboard_id to " +
    "subsequent dashboard-targeting tools. activate defaults to true and routes the " +
    "browser to the new dashboard.",
);

export async function manageAppsHandler(args: {
  operation: "list" | "read" | "instantiate";
  backend_id: string;
  app_name?: string;
  template_id?: string;
  dashboard_name?: string;
  activate?: boolean;
}): Promise<{ content: ContentItem[] }> {
  if (!args.backend_id) {
    return {
      content: [invalidRequestItem("manage_apps requires backend_id.")],
    };
  }
  if (
    (args.operation === "read" || args.operation === "instantiate") &&
    !args.app_name &&
    !args.template_id
  ) {
    return {
      content: [
        invalidRequestItem(
          `manage_apps operation='${args.operation}' requires app_name or template_id.`,
        ),
      ],
    };
  }

  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "manage_apps",
    operation: args.operation,
    backend_id: args.backend_id,
    app_name: args.app_name ?? null,
    template_id: args.template_id ?? null,
    dashboard_name: args.dashboard_name ?? null,
    activate: args.activate ?? null,
  });
  return { content };
}

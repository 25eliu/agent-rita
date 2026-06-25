/**
 * manage_dashboard — create / read / update one Workspace dashboard.
 *
 * Mirrors workspace_mcp/server.py:639-686 with operation-specific required
 * fields enforced inline.
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";
import { invalidRequestItem } from "../../bridge/validators";
import { describeTool } from "../../bridge/instructions";

export const manageDashboardSchema = {
  operation: z
    .enum(["create", "read", "update"])
    .describe("Operation to perform on the dashboard."),
  dashboard_id: z.string().optional().describe(
    "Dashboard UUID. Omit on read to target the current Workspace route. " +
      "Required for update.",
  ),
  name: z.string().optional().describe(
    "Dashboard display name. Required for create and update.",
  ),
  activate: z.boolean().optional().describe(
    "On create, whether to activate the new dashboard route. Defaults true.",
  ),
} as const;

export const manageDashboardDescription = describeTool(
  "Create, read, or update one Workspace dashboard.",
  "Requires operation from {create, read, update}.",
  "For create, pass name and optional dashboard_id and activate.",
  "For read, pass optional dashboard_id; omitted dashboard_id targets the current dashboard route.",
  "For update, pass dashboard_id and name.",
);

export async function manageDashboardHandler(args: {
  operation: "create" | "read" | "update";
  dashboard_id?: string;
  name?: string;
  activate?: boolean;
}): Promise<{ content: ContentItem[] }> {
  if (args.operation === "create") {
    if (!args.name) {
      return {
        content: [
          invalidRequestItem(
            "manage_dashboard operation='create' requires name.",
          ),
        ],
      };
    }
    const { content } = await executeBridgeCommand(bridgeManager, {
      command: "manage_dashboard",
      operation: "create",
      name: args.name,
      dashboard_id: args.dashboard_id ?? null,
      activate: args.activate ?? true,
    });
    return { content };
  }

  if (args.operation === "read") {
    const { content } = await executeBridgeCommand(bridgeManager, {
      command: "manage_dashboard",
      operation: "read",
      dashboard_id: args.dashboard_id ?? null,
      name: null,
      activate: null,
    });
    return { content };
  }

  // update
  if (!args.dashboard_id || args.name === undefined) {
    return {
      content: [
        invalidRequestItem(
          "manage_dashboard operation='update' requires dashboard_id and name.",
        ),
      ],
    };
  }
  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "manage_dashboard",
    operation: "update",
    dashboard_id: args.dashboard_id,
    name: args.name,
    activate: null,
  });
  return { content };
}

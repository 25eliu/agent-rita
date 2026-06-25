/**
 * navigate_workspace — push the Workspace router to a dashboard or inner tab.
 *
 * Mirrors workspace_mcp/server.py:1186-1227 with operation-specific required
 * fields enforced inline.
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";
import { invalidRequestItem } from "../../bridge/validators";
import { describeTool, DASHBOARD_TARGETING_GUIDANCE } from "../../bridge/instructions";

export const navigateWorkspaceSchema = {
  operation: z
    .enum(["dashboard", "tab"])
    .describe("Navigation target: 'dashboard' (full route) or 'tab' (inner tab)."),
  dashboard_id: z
    .string()
    .optional()
    .describe("Dashboard UUID. Required when operation='dashboard'."),
  tab_id: z
    .string()
    .optional()
    .describe(
      "Tab id (slug-form, e.g. 'aapl-analysis'). Required when operation='tab'.",
    ),
} as const;

export const navigateWorkspaceDescription = describeTool(
  "Navigate the Workspace browser to an existing dashboard or inner tab.",
  "Requires operation from {dashboard, tab}.",
  "For dashboard, pass dashboard_id. For tab, pass tab_id.",
  DASHBOARD_TARGETING_GUIDANCE,
);

export async function navigateWorkspaceHandler(args: {
  operation: "dashboard" | "tab";
  dashboard_id?: string;
  tab_id?: string;
}): Promise<{ content: ContentItem[] }> {
  if (args.operation === "dashboard") {
    if (!args.dashboard_id) {
      return {
        content: [
          invalidRequestItem(
            "navigate_workspace operation='dashboard' requires dashboard_id.",
          ),
        ],
      };
    }
    const { content } = await executeBridgeCommand(bridgeManager, {
      command: "navigate_workspace",
      operation: "dashboard",
      dashboard_id: args.dashboard_id,
      tab_id: null,
    });
    return { content };
  }

  // tab
  if (!args.tab_id) {
    return {
      content: [
        invalidRequestItem(
          "navigate_workspace operation='tab' requires tab_id.",
        ),
      ],
    };
  }
  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "navigate_workspace",
    operation: "tab",
    dashboard_id: null,
    tab_id: args.tab_id,
  });
  return { content };
}

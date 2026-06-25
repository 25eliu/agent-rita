/**
 * manage_navigation_bar — create or mutate navigation tabs on a dashboard.
 *
 * Mirrors workspace_mcp/server.py:886-936. tabs_json + rename_map_json carry
 * structured payloads as JSON-string args (workaround for MCP clients that
 * struggle with nested object inputs).
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";
import {
  invalidRequestItem,
  validateNavigationTabs,
} from "../../bridge/validators";
import {
  parseJsonList,
  parseJsonObject,
  JsonArgumentError,
} from "../../bridge/json-args";
import {
  describeTool,
  DASHBOARD_TARGETING_GUIDANCE,
  EXISTING_DASHBOARD_GUIDANCE,
  NAVIGATION_BAR_GUIDANCE,
} from "../../bridge/instructions";

export const manageNavigationBarSchema = {
  operation: z
    .enum(["create", "add_tabs", "remove_tabs", "rename_tabs"])
    .describe("Operation: create | add_tabs | remove_tabs | rename_tabs."),
  dashboard_id: z.string().optional().describe(
    "Dashboard UUID. Omit to target the current Workspace route.",
  ),
  tabs_json: z.string().optional().describe(
    'JSON array of tab objects, e.g. [{"name":"AAPL Analysis"}]. ' +
      "Required for create, add_tabs, remove_tabs.",
  ),
  rename_map_json: z.string().optional().describe(
    'JSON object {oldTabId: newName}, e.g. {"old-tab":"New Name"}. ' +
      "Required for rename_tabs.",
  ),
} as const;

export const manageNavigationBarDescription = describeTool(
  "Create or mutate the Workspace navigation bar.",
  "Requires operation from {create, add_tabs, remove_tabs, rename_tabs}.",
  'For add_tabs, pass tabs_json as a JSON array of objects, for example [{"name":"AAPL Analysis"}].',
  "The only tab object field for create/add/remove is name; do not send tab_id or tab_name. The tab_id is generated as the slug of name.",
  'Do not pass tabs_json as ["AAPL Analysis"]; string arrays are rejected.',
  "After add_tabs, navigate to the generated slug tab_id, e.g. AAPL Analysis -> aapl-analysis, before creating content for that tab.",
  'For rename_tabs, pass rename_map_json as a JSON object, for example {"old-tab-id":"New Name"}.',
  DASHBOARD_TARGETING_GUIDANCE,
  EXISTING_DASHBOARD_GUIDANCE,
  NAVIGATION_BAR_GUIDANCE,
);

export async function manageNavigationBarHandler(args: {
  operation: "create" | "add_tabs" | "remove_tabs" | "rename_tabs";
  dashboard_id?: string;
  tabs_json?: string;
  rename_map_json?: string;
}): Promise<{ content: ContentItem[] }> {
  let tabs: Array<Record<string, unknown>>;
  let renameMap: Record<string, unknown>;
  try {
    tabs = parseJsonList("manage_navigation_bar", "tabs_json", args.tabs_json);
    renameMap = parseJsonObject(
      "manage_navigation_bar",
      "rename_map_json",
      args.rename_map_json,
    );
  } catch (err) {
    if (err instanceof JsonArgumentError) {
      return { content: [err.toContentItem()] };
    }
    throw err;
  }

  if (args.operation === "create" || args.operation === "add_tabs") {
    if (tabs.length === 0) {
      return {
        content: [
          invalidRequestItem(
            `manage_navigation_bar operation='${args.operation}' requires non-empty tabs_json.`,
          ),
        ],
      };
    }
  }
  if (args.operation === "remove_tabs" && tabs.length === 0) {
    return {
      content: [
        invalidRequestItem(
          "manage_navigation_bar operation='remove_tabs' requires non-empty tabs_json.",
        ),
      ],
    };
  }
  if (args.operation === "rename_tabs" && Object.keys(renameMap).length === 0) {
    return {
      content: [
        invalidRequestItem(
          "manage_navigation_bar operation='rename_tabs' requires rename_map_json with at least one entry.",
        ),
      ],
    };
  }

  const tabValidation = validateNavigationTabs(args.operation, tabs);
  if (tabValidation) {
    return { content: [invalidRequestItem(tabValidation)] };
  }

  // Wire schema's rename_map is Record<string, string>. Cast values that
  // happen to be non-strings to string for safety; could also reject upstream.
  const renameMapStr: Record<string, string> = {};
  for (const [k, v] of Object.entries(renameMap)) {
    renameMapStr[k] = String(v);
  }

  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "manage_navigation_bar",
    operation: args.operation,
    dashboard_id: args.dashboard_id ?? null,
    tabs,
    rename_map: renameMapStr,
  });
  return { content };
}

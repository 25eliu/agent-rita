/**
 * get_workspace_snapshot — fetch current OpenBB Workspace snapshot.
 *
 * Pure pass-through to the connected browser bridge. Mirrors
 * workspace_mcp/server.py:496.
 */

import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";

export const getWorkspaceSnapshotSchema = {} as const;

export const getWorkspaceSnapshotDescription =
  "Request a fresh OpenBB Workspace snapshot from the connected browser. " +
  "Call this first when you need current dashboard state, dashboard identifiers across the workspace, or skill identifiers. " +
  "The snapshot is intentionally compact: use list_available_widgets, get_widget_schema, and manage_dashboard for deeper follow-up inspection. " +
  "dashboard_composition exposes deterministic tabs, layout coordinates, and groups for the current dashboard.";

export async function getWorkspaceSnapshotHandler(): Promise<{
  content: ContentItem[];
}> {
  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "get_workspace_snapshot",
  });
  return { content };
}

/**
 * MCP prompts for the workspace tool surface.
 *
 * Mirrors workspace_mcp/server.py:462-479 + 438-450.
 *
 * Multi-session note: Python uses a single bridge state, so prompts read its
 * single session_context directly. Our manager is multi-session — for PoC we
 * read from the first connected session. Future: pass an explicit session id
 * via prompt argsSchema.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { bridgeManager } from "../bridge/singleton";
import { SERVER_INSTRUCTIONS } from "../bridge/instructions";

function sessionContextPromptContent(): string {
  const sessionId = bridgeManager.getFirstConnectedSessionId();
  if (sessionId === null) {
    return "No Workspace browser session context is currently available.";
  }
  const ctx = bridgeManager.getSessionContext(sessionId);
  if (ctx === null) {
    return "No Workspace browser session context is currently available.";
  }
  const dashboardId = ctx.current_dashboard_id ?? "none";
  const tabId = ctx.current_tab_id ?? "none";
  return (
    "Current Workspace browser session context: " +
    `current_dashboard_id=${dashboardId}; ` +
    `current_tab_id=${tabId}.`
  );
}

export function registerWorkspacePrompts(mcp: McpServer): void {
  mcp.registerPrompt(
    "workspace_tool_usage",
    {
      description:
        "Generic guidance for using the OpenBB Workspace MCP tool surface.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: SERVER_INSTRUCTIONS },
        },
        {
          role: "user",
          content: { type: "text", text: sessionContextPromptContent() },
        },
      ],
    }),
  );

  mcp.registerPrompt(
    "workspace_session_context",
    {
      description: "Current tracked Workspace dashboard and tab context.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: sessionContextPromptContent() },
        },
      ],
    }),
  );
}

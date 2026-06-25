/**
 * Helper for workspace tool handlers: dispatch a WorkspaceCommand through
 * the bridge to the connected browser, await the result, and shape it into
 * an MCP ContentItem envelope.
 *
 * PoC default: when no `sessionId` is passed, route to the first connected
 * browser. Production: agent-side decoration injects `x-agentrita-bridge-session-id`
 * (deferred — see plan unresolved questions).
 */

import { errorItem, textItem, type ContentItem } from "../lib/typed";
import {
  BrowserUnavailableError,
  type BridgeSessionManager,
} from "./state";
import type { WorkspaceCommand, WorkspaceCommandResult } from "./wire";

export interface ExecuteBridgeOpts {
  sessionId?: string;
}

export async function executeBridgeCommand(
  manager: BridgeSessionManager,
  command: WorkspaceCommand,
  opts: ExecuteBridgeOpts = {},
): Promise<{ content: ContentItem[]; result: WorkspaceCommandResult | null }> {
  const sessionId = opts.sessionId ?? manager.getFirstConnectedSessionId();
  if (!sessionId) {
    return {
      content: [
        errorItem({
          code: "unavailable",
          message:
            "No connected OpenBB Workspace browser. Open the workspace and connect the bridge before calling this tool.",
          retryable: true,
        }),
      ],
      result: null,
    };
  }

  let result: WorkspaceCommandResult;
  try {
    result = await manager.executeCommand(sessionId, command);
  } catch (err) {
    if (err instanceof BrowserUnavailableError) {
      return {
        content: [
          errorItem({
            code: "unavailable",
            message: err.message,
            retryable: true,
          }),
        ],
        result: null,
      };
    }
    throw err;
  }

  if (!result.ok) {
    return {
      content: [
        errorItem({
          code: result.error?.code ?? "command_failed",
          message: result.message,
          retryable: result.error?.retryable ?? false,
        }),
      ],
      result,
    };
  }

  return { content: [textItem(JSON.stringify(result))], result };
}

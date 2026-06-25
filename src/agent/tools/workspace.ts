/**
 * Native workspace bridge tool factory.
 *
 * Each command in `WORKSPACE_BRIDGE_COMMANDS` becomes a no-execute Vercel
 * AI SDK tool: when the model picks one, the agent loop emits a
 * `copilotFunctionCall` SSE with `function: <command>` and the bridge
 * shape as `input_arguments`. The frontend's
 * `useWorkspaceBridgeCommandHandler` runs the actual operation.
 *
 * No agent-side execution: this layer is pure declaration. All workspace
 * mutation logic lives in the browser bridge handler.
 */

import { tool, type Tool, type ToolSet } from "ai";
import {
  WORKSPACE_BRIDGE_COMMANDS,
  WORKSPACE_BRIDGE_COMMAND_NAMES,
  type WorkspaceBridgeCommandSpec,
} from "../../protocol/bridge-commands";

function buildTool(spec: WorkspaceBridgeCommandSpec): Tool {
  return tool({
    description: spec.description,
    inputSchema: spec.inputSchema,
  });
}

/**
 * Build a ToolSet for the workspace bridge commands. Pass `enabledNames`
 * to register a subset; omit to register all 16. Names not in the
 * vendored registry are ignored.
 */
export function makeWorkspaceTools(enabledNames?: ReadonlySet<string>): ToolSet {
  const out: ToolSet = {};
  for (const spec of WORKSPACE_BRIDGE_COMMANDS) {
    if (enabledNames && !enabledNames.has(spec.name)) continue;
    out[spec.name] = buildTool(spec);
  }
  return out;
}

export { WORKSPACE_BRIDGE_COMMAND_NAMES };

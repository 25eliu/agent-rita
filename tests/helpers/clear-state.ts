/**
 * Clears all module-level state that test files might share when running
 * inside a single bun test process. Call from `beforeEach` for any test
 * that touches the agent loop, row cache, or compute sandbox.
 */

import { _resetWidgetDataCache } from "../../src/agent/loop";
import { _resetSandboxState } from "../../mcp-server/src/tools/backend/compute/sandbox";

export function clearAllModuleState(): void {
  _resetWidgetDataCache();
  _resetSandboxState();
  (globalThis as { __rita_chat_row_cache?: Map<string, unknown> })
    .__rita_chat_row_cache?.clear();
}

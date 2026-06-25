/**
 * Tier 1 — workspace bridge tool factory.
 */

import { describe, it, expect } from "bun:test";
import { makeWorkspaceTools } from "../../../../../src/agent/tools/workspace";
import {
  WORKSPACE_BRIDGE_COMMANDS,
  WORKSPACE_BRIDGE_COMMAND_NAMES,
} from "../../../../../src/protocol/bridge-commands";

describe("makeWorkspaceTools — registry coverage", () => {
  it("registers one no-execute tool per bridge command by default", () => {
    const tools = makeWorkspaceTools();
    expect(Object.keys(tools).sort()).toEqual(
      WORKSPACE_BRIDGE_COMMANDS.map((c) => c.name).sort(),
    );
    for (const t of Object.values(tools)) {
      expect((t as { execute?: unknown }).execute).toBeUndefined();
    }
  });

  it("each tool's description matches the registry description", () => {
    const tools = makeWorkspaceTools();
    for (const spec of WORKSPACE_BRIDGE_COMMANDS) {
      const t = tools[spec.name] as { description?: string };
      expect(t.description).toBe(spec.description);
    }
  });

  it("WORKSPACE_BRIDGE_COMMAND_NAMES matches the factory output", () => {
    const tools = makeWorkspaceTools();
    expect(new Set(Object.keys(tools))).toEqual(
      new Set(WORKSPACE_BRIDGE_COMMAND_NAMES),
    );
  });
});

describe("makeWorkspaceTools — enabledNames filter", () => {
  it("registers only the enabled subset", () => {
    const tools = makeWorkspaceTools(new Set(["manage_dashboard", "add_widget_to_dashboard"]));
    expect(Object.keys(tools).sort()).toEqual(["add_widget_to_dashboard", "manage_dashboard"]);
  });

  it("ignores names not in the registry", () => {
    const tools = makeWorkspaceTools(new Set(["manage_dashboard", "not_a_command"]));
    expect(Object.keys(tools)).toEqual(["manage_dashboard"]);
  });

  it("returns an empty ToolSet when enabledNames is empty", () => {
    const tools = makeWorkspaceTools(new Set());
    expect(Object.keys(tools)).toEqual([]);
  });
});

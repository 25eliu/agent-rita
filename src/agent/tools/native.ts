/**
 * Tiny factory hub for the agent-owned "native" tools that round out parity
 * with Ada's tool surface (think / enhance / table-from-text / html artifact).
 * SQL family + create_artifact stay in `./sql/` because they share the
 * SQLite + create_artifact closure; everything here is independent and
 * state-bound only to the artifact queue or pendingTables.
 */

import type { ToolSet } from "ai";
import type { SSEEvent } from "../../protocol/types";
import type { TableInfo } from "../../sql/loader";
import { makeEnhancePromptTool } from "./enhance-prompt";
import { makeLlmThinkTool } from "./think";
import { makeTableFromTextTool } from "./table-from-text";
import { makeHtmlArtifactTool } from "./html-artifact";

export const NATIVE_TOOL_NAMES = [
  "enhance_prompt",
  "_llm_think",
  "create_table_from_text",
  "create_html_artifact",
  // create_app is its own factory (closes over allWidgets); listed here so the
  // MCP factory drops any Path-B `*_create_app` wrapper that would double-register.
  "create_app",
  // suggest_followups is its own factory (closes over the request suggestions
  // var) and is registered conditionally (suggestionsVia === "tool"); listed
  // here so the MCP factory never double-registers a colliding wrapper.
  "suggest_followups",
] as const;

export const NATIVE_TOOL_NAME_SET: ReadonlySet<string> = new Set(NATIVE_TOOL_NAMES);

export interface NativeToolsContext {
  pendingTables: Map<string, Record<string, unknown>[]>;
  tablesShipped: Set<string>;
  artifactQueue: SSEEvent[];
  tables: TableInfo[];
  conversationId: string;
}

export function makeNativeTools(ctx: NativeToolsContext): ToolSet {
  return {
    enhance_prompt: makeEnhancePromptTool(),
    _llm_think: makeLlmThinkTool({ artifactQueue: ctx.artifactQueue }),
    create_table_from_text: makeTableFromTextTool({
      pendingTables: ctx.pendingTables,
      tablesShipped: ctx.tablesShipped,
      artifactQueue: ctx.artifactQueue,
      tables: ctx.tables,
      conversationId: ctx.conversationId,
    }),
    create_html_artifact: makeHtmlArtifactTool({
      artifactQueue: ctx.artifactQueue,
    }),
  };
}

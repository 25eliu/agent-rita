/**
 * SQL family — read-widget-data tools that run in-process on the agent.
 * Stateless per call, no MCP detour, no decoration.
 */

import type { ToolSet } from "ai";
import type { SSEEvent } from "../../../protocol/types";
import { makeExecuteSqlTool } from "./execute-sql";
import { makePeekTableTool } from "./peek-table";
import { makePeekColumnValuesTool } from "./peek-column-values";
import { makeCreateArtifactTool } from "./create-artifact";

export interface SqlToolsContext {
  pendingTables: Map<string, Record<string, unknown>[]>;
  artifactQueue: SSEEvent[];
  codeExecutionAvailable?: boolean;
}

export const SQL_TOOL_NAMES = [
  "execute_sql",
  "peek_table",
  "peek_column_values",
  "create_artifact",
] as const;

export const SQL_TOOL_NAME_SET: ReadonlySet<string> = new Set(SQL_TOOL_NAMES);

export function makeSqlTools(ctx: SqlToolsContext): ToolSet {
  return {
    execute_sql: makeExecuteSqlTool(ctx, { codeExecutionAvailable: ctx.codeExecutionAvailable }),
    peek_table: makePeekTableTool(ctx),
    peek_column_values: makePeekColumnValuesTool(ctx),
    create_artifact: makeCreateArtifactTool(ctx),
  };
}

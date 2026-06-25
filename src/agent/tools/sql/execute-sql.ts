/**
 * execute_sql — runs SQLite SELECT/WITH against widget data already
 * loaded into the agent's request-scoped `pendingTables`. Stateless: a
 * fresh in-memory DB is built per call and dropped on return.
 *
 * Local execute: agent runs this in-process. No MCP detour, no
 * decoration, no x-agentrita-tables ship.
 */

import { tool } from "ai";
import { z } from "zod";
import { buildDb } from "./db";
import { availableTablesHint } from "./error-hints";
import { rejectUnsafeSql } from "./safety";
import { getLogger } from "../../../lib/logger";
import { DISPLAY_SUMMARY_TOOL_TEXT, displaySummarySchema } from "../progress";

const logger = getLogger(["app", "tools", "sql", "execute_sql"]);

const MAX_ROWS = 1000;

export const executeSqlSchema = z.object({
  display_summary: displaySummarySchema,
  sql: z.string().describe(
    "SQLite SELECT or WITH (CTE). Use double-quotes for identifiers with spaces or mixed case. Returns up to 1000 rows. Result columns are not persisted; repeat derived aliases in the same query with a CTE/subquery when filtering or ordering by them.",
  ),
});

export const executeSqlDescription =
  "Run a SQL query against widget data already loaded for this conversation. " +
  DISPLAY_SUMMARY_TOOL_TEXT + " " +
  "SQLite dialect. SELECT and WITH/CTE only. Returns up to 1000 rows as JSON. " +
  "Result columns/aliases from one execute_sql call are not added to loaded tables; if you need to sort, filter, chart, or artifact a derived alias, compute it in the same SQL using a WITH CTE or subquery. " +
  "This is the fast path — use it for filters, aggregations, joins, peeks. " +
  "For Python statistics or interactive plotly charts, use execute_code instead.";

export const executeSqlDescriptionWithoutCode =
  "Run a SQL query against widget data already loaded for this conversation. " +
  DISPLAY_SUMMARY_TOOL_TEXT + " " +
  "SQLite dialect. SELECT and WITH/CTE only. Returns up to 1000 rows as JSON. " +
  "Result columns/aliases from one execute_sql call are not added to loaded tables; if you need to sort, filter, chart, or artifact a derived alias, compute it in the same SQL using a WITH CTE or subquery. " +
  "This is the fast path — use it for filters, aggregations, joins, peeks. " +
  "Python execute_code is not available in this turn.";

export interface ExecuteSqlContext {
  pendingTables: Map<string, Record<string, unknown>[]>;
}

function sqlSummary(sql: string, rows: Record<string, unknown>[]): string {
  const truncated = rows.length > MAX_ROWS;
  const out = truncated ? rows.slice(0, MAX_ROWS) : rows;
  return (
    `SQL: ${sql.slice(0, 200)}${sql.length > 200 ? "..." : ""}\n` +
    `Rows: ${rows.length}${truncated ? ` (TRUNCATED — showing first ${MAX_ROWS})` : ""}\n\n` +
    JSON.stringify(out, null, 2)
  );
}

export function runExecuteSql(
  args: { sql: string },
  ctx: ExecuteSqlContext,
): string {
  const startedAt = Date.now();
  const tableNames = [...ctx.pendingTables.keys()];
  logger.info(
    `execute_sql entry sqlPreview=${JSON.stringify(args.sql.slice(0, 120))} tables=${tableNames.length}`,
    {
      sqlChars: args.sql.length,
      tableNames,
      totalRows: [...ctx.pendingTables.values()].reduce((s, r) => s + r.length, 0),
    },
  );

  const reject = rejectUnsafeSql(args.sql);
  if (reject) return reject;

  const { db, loaded } = buildDb(ctx.pendingTables);
  try {
    const rows = db.query(args.sql).all() as Record<string, unknown>[];
    const summary = sqlSummary(args.sql, rows);
    logger.info(
      `execute_sql exit rows=${rows.length}${rows.length > MAX_ROWS ? " (truncated)" : ""} ms=${Date.now() - startedAt}`,
      { totalMs: Date.now() - startedAt, rowCount: rows.length, truncated: rows.length > MAX_ROWS },
    );
    return summary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const tableHint = availableTablesHint(loaded);
    logger.warn(`execute_sql error msg=${JSON.stringify(msg.slice(0, 200))}`, { error: msg });
    return `SQL error: ${msg}.${tableHint}`;
  } finally {
    db.close();
  }
}

export function makeExecuteSqlTool(
  ctx: ExecuteSqlContext,
  options: { codeExecutionAvailable?: boolean } = {},
) {
  return tool({
    description: options.codeExecutionAvailable ? executeSqlDescription : executeSqlDescriptionWithoutCode,
    inputSchema: executeSqlSchema,
    execute: async (args) => runExecuteSql(args, ctx),
  });
}

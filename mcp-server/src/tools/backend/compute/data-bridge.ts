/**
 * Data bridge: reads decoration params injected by the agent and lands them
 * into the conversation's DuckDB instance inside the Daytona sandbox.
 *
 * Decoration contract (set by the agent in src/agent/loop.ts before emitting
 * the executeAgentTool SSE):
 *
 *   x-agentrita-conversation-id: string         REQUIRED
 *   x-agentrita-tables:          {[name]: rows} OPTIONAL — only NEW tables
 *                                                          since last call
 *
 * Tables are uploaded as JSON files to /tmp/rita_<name>.json then loaded
 * into DuckDB via `read_json_auto`. Type inference is delegated to DuckDB.
 */

import type { Sandbox } from "@daytonaio/sdk";
import { getSandbox, dropSandbox } from "./sandbox";
import { getLogger } from "../../../lib/logger";

const logger = getLogger(["mcp", "compute", "data-bridge"]);

const DATA_LOAD_TIMEOUT_SEC = 60;

export interface DecoratedArgs {
  conversationId: string;
  tables?: Record<string, unknown[]>;
}

/**
 * Pull decoration params out of a tool's args object. The agent always sets
 * the conversation id; tables are only sent on the first call after data
 * lands (delta).
 */
export function readDecoration(args: Record<string, unknown>): DecoratedArgs {
  const conversationId = args["x-agentrita-conversation-id"];
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    throw new Error("missing x-agentrita-conversation-id (agent decoration)");
  }
  const tablesRaw = args["x-agentrita-tables"];
  let tables: Record<string, unknown[]> | undefined;
  if (tablesRaw && typeof tablesRaw === "object" && !Array.isArray(tablesRaw)) {
    tables = {};
    for (const [name, rows] of Object.entries(tablesRaw)) {
      if (Array.isArray(rows)) tables[name] = rows;
    }
    if (Object.keys(tables).length === 0) tables = undefined;
  }
  return { conversationId, tables };
}

function sanitizeTableName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "t_$1") || "t";
}

async function uploadTable(
  sandbox: Sandbox,
  name: string,
  rows: unknown[],
  conversationId: string,
): Promise<{ tableName: string; remotePath: string; rowCount: number; bytes: number }> {
  const tableName = sanitizeTableName(name);
  const remotePath = `/tmp/rita_${tableName}.json`;
  const buf = Buffer.from(JSON.stringify(rows), "utf-8");
  const startedAt = Date.now();
  await sandbox.fs.uploadFile(buf, remotePath);
  logger.info("Table uploaded", {
    conversationId,
    tableName,
    rowCount: rows.length,
    bytes: buf.byteLength,
    uploadMs: Date.now() - startedAt,
  });
  return { tableName, remotePath, rowCount: rows.length, bytes: buf.byteLength };
}

/**
 * Resolve sandbox for the conversation and load any new tables. Returns the
 * ready sandbox + summary of what was loaded.
 */
export async function prepareCompute(args: Record<string, unknown>): Promise<{
  sandbox: Sandbox;
  conversationId: string;
  loaded: Array<{ tableName: string; rowCount: number }>;
}> {
  const { conversationId, tables } = readDecoration(args);

  let sandbox: Sandbox;
  try {
    sandbox = await getSandbox(conversationId);
  } catch (err) {
    throw new Error(
      `compute sandbox unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const loaded: Array<{ tableName: string; rowCount: number }> = [];
  if (!tables || Object.keys(tables).length === 0) {
    return { sandbox, conversationId, loaded };
  }

  const uploads: Array<{ tableName: string; remotePath: string; rowCount: number; bytes: number }> = [];
  for (const [name, rows] of Object.entries(tables)) {
    if (rows.length === 0) continue;
    uploads.push(await uploadTable(sandbox, name, rows, conversationId));
  }
  if (uploads.length === 0) return { sandbox, conversationId, loaded };

  // Load via pandas instead of read_json_auto. read_json_auto picks one
  // strict timestamp format from the first sample and then errors on any
  // value that doesn't match (e.g. microsecond-precision ISO strings).
  // pandas.DataFrame(rows) preserves strings as strings by default; DuckDB
  // takes the DataFrame as-is. Numbers stay numbers, timestamps stay
  // queryable as text (use strptime / cast in SQL when needed).
  const fileList = uploads
    .map((u) => `(${JSON.stringify(u.remotePath)}, ${JSON.stringify(u.tableName)})`)
    .join(", ");
  const loaderCode = `
import duckdb, json, traceback
import pandas as pd
con = duckdb.connect("/tmp/rita.db")
try:
    for path, name in [${fileList}]:
        with open(path) as f:
            rows = json.load(f)
        df = pd.DataFrame(rows)
        con.register("rita_staging", df)
        con.execute('CREATE OR REPLACE TABLE "' + name + '" AS SELECT * FROM rita_staging')
        con.unregister("rita_staging")
    print("rita-load:ok")
except Exception as e:
    print("rita-load:error:" + str(e))
    print(traceback.format_exc())
`;

  const loadStart = Date.now();
  let result;
  try {
    result = await sandbox.process.codeRun(loaderCode, {}, DATA_LOAD_TIMEOUT_SEC);
  } catch (err) {
    dropSandbox(conversationId);
    throw new Error(
      `compute load failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const out = result.result ?? "";
  if (!out.includes("rita-load:ok")) {
    throw new Error(`compute load failed: ${out.slice(0, 500)}`);
  }
  for (const u of uploads) loaded.push({ tableName: u.tableName, rowCount: u.rowCount });
  logger.info("Tables loaded into DuckDB", {
    conversationId,
    tableCount: uploads.length,
    totalRows: uploads.reduce((s, u) => s + u.rowCount, 0),
    totalBytes: uploads.reduce((s, u) => s + u.bytes, 0),
    duckdbLoadMs: Date.now() - loadStart,
  });
  return { sandbox, conversationId, loaded };
}

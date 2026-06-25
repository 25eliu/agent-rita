/**
 * Table analyzer used by the agent to derive schema/preview text from
 * incoming widget rows or MCP-provided rows. The actual SQL execution
 * lives in the compute MCP server (DuckDB inside a Daytona sandbox);
 * this file is purely about producing a `TableInfo` for prompting and
 * for keying `pendingTables` (which the decoration step ships to compute).
 */

export function sanitizeName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^(\d)/, "col_$1")
    .toLowerCase();
}

// Cap how far we scan when inferring a column's SQL type. Sparse columns
// (populated only past row 50) used to be misclassified as TEXT because the
// old sample window was 50 rows; bumping to 500 catches the realistic cases
// without paying full O(N) on huge payloads. The loop also bails on the
// first non-null cell, so well-populated columns cost ~1 dereference.
const TYPE_SAMPLE_LIMIT = 500;

function inferSqlType(rows: Record<string, unknown>[], key: string): string {
  const cap = Math.min(rows.length, TYPE_SAMPLE_LIMIT);
  for (let i = 0; i < cap; i++) {
    const v = rows[i][key];
    if (v == null) continue;
    if (typeof v === "number") return Number.isInteger(v) ? "INTEGER" : "REAL";
    if (typeof v === "boolean") return "INTEGER";
    return "TEXT";
  }
  return "TEXT";
}

export interface TableInfo {
  tableName: string;
  columns: { name: string; originalName: string; type: string }[];
  rowCount: number;
}

/**
 * Disambiguate columns whose sanitized names collide. Real-world widget
 * payloads can have keys that differ only by case (`{ a, A }`) or by
 * separator (`{ "foo bar", "foo-bar" }`); both sanitize to the same
 * SQL identifier. Suffix duplicates with `_2`, `_3`, … so CREATE TABLE
 * doesn't fail and each column maps back to its originalName for value
 * insertion.
 */
function dedupColumnNames<T extends { name: string }>(cols: T[]): T[] {
  const seen = new Map<string, number>();
  return cols.map((col) => {
    const count = (seen.get(col.name) ?? 0) + 1;
    seen.set(col.name, count);
    return count === 1 ? col : { ...col, name: `${col.name}_${count}` };
  });
}

/**
 * Inspect a row array and return a sanitized table name + column metadata.
 * Pure — does not write to any database. The rows themselves stay in the
 * caller's Map until shipped to the compute sandbox.
 */
export function analyzeTable(
  name: string,
  rows: Record<string, unknown>[],
): TableInfo {
  const tableName = sanitizeName(name) || "data";
  const originalKeys = Object.keys(rows[0] ?? {});
  const columns = dedupColumnNames(
    originalKeys.map((key) => ({
      name: sanitizeName(key),
      originalName: key,
      type: inferSqlType(rows, key),
    })),
  );
  return { tableName, columns, rowCount: rows.length };
}

/**
 * Re-key rows to the sanitized column names `analyzeTable` reports. The
 * model only ever sees sanitized names (loaded-tables inventory, execute_sql
 * results), so anything that leaves the agent — in particular the
 * `x-agentrita-tables` payload shipped to the compute sandbox — must carry
 * the same keys. Shipping raw keys gives the sandbox a different schema
 * (e.g. camelCase `startDate`) than the model was told (`startdate`):
 * DuckDB's case-insensitive SQL masks the mismatch, then pandas'
 * case-sensitive indexing crashes. Returns new row objects; input untouched.
 */
export function sanitizeRowKeys(
  name: string,
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const { columns } = analyzeTable(name, rows);
  return rows.map((row) =>
    Object.fromEntries(columns.map((col) => [col.name, row[col.originalName]])),
  );
}

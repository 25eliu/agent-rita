/**
 * SQL safety gates shared by the in-process SQL family.
 *
 * Defense in depth: bun:sqlite already runs against a fresh per-call
 * `:memory:` DB seeded only from `pendingTables`, so write paths can't
 * touch user-visible state. These checks reject queries that betray
 * adversarial or buggy intent before they reach `db.query`:
 *
 *   - non-SELECT/WITH prefix (UPDATE, DROP, etc).
 *   - SQLite internals (`sqlite_master` and friends — information disclosure).
 *   - `PRAGMA` (config + schema disclosure).
 *   - `ATTACH DATABASE` / `DETACH DATABASE` (escapes the in-memory DB).
 *
 * Multi-statement input (`SELECT 1; DROP TABLE x`) is rejected by
 * bun:sqlite's `query` (one prepared statement per call). A regression
 * test pins that behavior so a later runtime change can't silently
 * widen the attack surface.
 */

const SAFE_PREFIX = /^(select|with)\b/i;

const DENY_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "sqlite internals", pattern: /\bsqlite_(master|schema|temp_master|temp_schema|sequence)\b/i },
  { name: "PRAGMA", pattern: /\bpragma_/i },
  { name: "ATTACH DATABASE", pattern: /\battach\s+database\b/i },
  { name: "DETACH DATABASE", pattern: /\bdetach\s+database\b/i },
  { name: "PRAGMA", pattern: /\bpragma\s+\w/i },
  // Multi-statement smuggling: bun:sqlite's `db.query(sql).all()` only
  // executes the first prepared statement, but if that contract ever
  // changes a trailing destructive stmt could land. Block any `;` that's
  // followed by a SQL keyword we wouldn't otherwise allow at the start.
  {
    name: "multi-statement",
    pattern: /;\s*(select|with|insert|update|delete|drop|create|alter|attach|detach|pragma|vacuum|replace)\b/i,
  },
];

const DENY_TABLE_NAME = /^sqlite_/i;

function stripLeadingSqlComments(sql: string): string {
  let rest = sql;
  while (true) {
    rest = rest.trimStart();
    if (rest.startsWith("--")) {
      const lineEnd = rest.indexOf("\n");
      if (lineEnd === -1) return "";
      rest = rest.slice(lineEnd + 1);
      continue;
    }
    if (rest.startsWith("/*")) {
      const blockEnd = rest.indexOf("*/", 2);
      if (blockEnd === -1) return rest;
      rest = rest.slice(blockEnd + 2);
      continue;
    }
    return rest;
  }
}

export function rejectUnsafeSql(sql: string): string | null {
  if (!SAFE_PREFIX.test(stripLeadingSqlComments(sql))) {
    return "Error: only SELECT or WITH (CTE) statements are allowed.";
  }
  for (const { name, pattern } of DENY_PATTERNS) {
    if (pattern.test(sql)) {
      return `Error: SQL rejected — references ${name}. Allowed: SELECT / WITH against loaded widget tables only.`;
    }
  }
  return null;
}

export function rejectUnsafeTableName(name: string): string | null {
  if (DENY_TABLE_NAME.test(name)) {
    return `Error: "${name}" is a SQLite internal table and is not accessible.`;
  }
  return null;
}

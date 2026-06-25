/**
 * SQL safety gates — defense-in-depth checks shared by execute_sql,
 * peek_table, and peek_column_values. Every match is a regression of a
 * real attack class (information disclosure via sqlite_master, escape via
 * ATTACH/DETACH, etc).
 */

import { describe, it, expect } from "bun:test";
import { rejectUnsafeSql, rejectUnsafeTableName } from "../../../../../../src/agent/tools/sql/safety";

describe("rejectUnsafeSql — prefix check", () => {
  const allowed = [
    "SELECT 1",
    "  select * from t",
    "WITH cte AS (SELECT 1) SELECT * FROM cte",
    "with RECURSIVE x AS (select 1) select * from x",
    "-- explain the query\nSELECT 1",
    "/* explain the query */\nWITH cte AS (SELECT 1) SELECT * FROM cte",
  ];
  for (const sql of allowed) {
    it(`accepts ${JSON.stringify(sql)}`, () => {
      expect(rejectUnsafeSql(sql)).toBeNull();
    });
  }

  const rejected = [
    "DELETE FROM t",
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET x = 1",
    "DROP TABLE t",
    "CREATE TABLE x (a INT)",
    "ALTER TABLE t ADD COLUMN c INT",
    "REPLACE INTO t VALUES (1)",
    "VACUUM",
    "",
    "   ",
  ];
  for (const sql of rejected) {
    it(`rejects ${JSON.stringify(sql)} as non-SELECT`, () => {
      expect(rejectUnsafeSql(sql)).toMatch(/SELECT or WITH/);
    });
  }
});

describe("rejectUnsafeSql — sqlite internals (information disclosure)", () => {
  // regression: sqlite_master / sqlite_schema and the temp/sequence siblings
  // expose the entire DB schema; an LLM that learns this name from web
  // training data could probe past the widget tables.
  const denied = [
    "SELECT name FROM sqlite_master",
    "select * from sqlite_schema",
    "SELECT * FROM sqlite_temp_master",
    "select * from sqlite_temp_schema",
    "select * from sqlite_sequence",
    "WITH t AS (SELECT 1) SELECT * FROM sqlite_master",
  ];
  for (const sql of denied) {
    it(`rejects ${JSON.stringify(sql)}`, () => {
      const out = rejectUnsafeSql(sql);
      expect(out).not.toBeNull();
      expect(out).toMatch(/sqlite internals/);
    });
  }
});

describe("rejectUnsafeSql — PRAGMA / ATTACH / DETACH", () => {
  it("rejects PRAGMA statements (config + schema disclosure)", () => {
    expect(rejectUnsafeSql("WITH t AS (PRAGMA foreign_keys) SELECT 1")).toMatch(/PRAGMA/);
  });

  it("rejects PRAGMA table-valued functions used for schema disclosure", () => {
    expect(rejectUnsafeSql("SELECT name FROM pragma_table_info('prices')")).toMatch(/PRAGMA/);
  });

  it("rejects ATTACH DATABASE (escape from in-memory DB)", () => {
    expect(rejectUnsafeSql("WITH t AS (ATTACH DATABASE 'evil.db' AS e) SELECT 1")).toMatch(/ATTACH/);
  });

  it("rejects DETACH DATABASE", () => {
    expect(rejectUnsafeSql("WITH t AS (DETACH DATABASE main) SELECT 1")).toMatch(/DETACH/);
  });
});

describe("rejectUnsafeSql — multi-statement smuggling", () => {
  // regression: `db.query(sql).all()` only runs the first prepared
  // statement today, but trailing destructive SQL is still semantically
  // dangerous if the runtime contract changes. Reject any `;` followed by
  // a SQL keyword we don't accept at statement start.
  const cases = [
    "SELECT 1; DROP TABLE x",
    "SELECT 1; INSERT INTO x VALUES (1)",
    "SELECT 1; DELETE FROM x",
    "SELECT 1; UPDATE x SET y = 1",
    "SELECT 1; CREATE TABLE x (a INT)",
    "SELECT 1; PRAGMA x",
    "SELECT 1; ATTACH DATABASE 'e' AS e",
  ];
  for (const sql of cases) {
    it(`rejects ${JSON.stringify(sql)}`, () => {
      expect(rejectUnsafeSql(sql)).not.toBeNull();
    });
  }
});

describe("rejectUnsafeTableName", () => {
  // regression: peek_table / peek_column_values accepted any string —
  // could be aimed at sqlite_master to dump the schema.
  const denied = ["sqlite_master", "sqlite_schema", "SQLITE_MASTER", "Sqlite_Sequence"];
  for (const name of denied) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      expect(rejectUnsafeTableName(name)).not.toBeNull();
    });
  }

  const allowed = ["prices", "user_data", "Prices", "_internal_widget_table", "data"];
  for (const name of allowed) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      expect(rejectUnsafeTableName(name)).toBeNull();
    });
  }
});

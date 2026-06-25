import { describe, it, expect } from "bun:test";
import { sanitizeName, analyzeTable, sanitizeRowKeys } from "../../../../src/sql/loader";

describe("sanitizeName", () => {
  it("lowercases the input", () => {
    expect(sanitizeName("PRICES")).toBe("prices");
  });

  it("replaces non-identifier characters with underscores", () => {
    expect(sanitizeName("foo-bar.baz")).toBe("foo_bar_baz");
    expect(sanitizeName("revenue ($)")).toBe("revenue____");
  });

  it("prefixes col_ when the name starts with a digit", () => {
    expect(sanitizeName("1_year")).toBe("col_1_year");
    expect(sanitizeName("2024 q1")).toBe("col_2024_q1");
  });
});

describe("analyzeTable", () => {
  it("derives column names + types from the first row", () => {
    const t = analyzeTable("Prices", [{ symbol: "NVDA", close: 100 }]);
    expect(t.tableName).toBe("prices");
    expect(t.rowCount).toBe(1);
    expect(t.columns).toEqual([
      { name: "symbol", originalName: "symbol", type: "TEXT" },
      { name: "close", originalName: "close", type: "INTEGER" },
    ]);
  });

  it("infers REAL when a number is non-integer", () => {
    const t = analyzeTable("p", [{ x: 1.5 }]);
    expect(t.columns[0].type).toBe("REAL");
  });

  it("infers INTEGER when values are booleans", () => {
    const t = analyzeTable("p", [{ flag: true }]);
    expect(t.columns[0].type).toBe("INTEGER");
  });

  it("falls back to TEXT for non-primitive values or all-null columns", () => {
    const t = analyzeTable("p", [{ a: { complex: 1 }, b: null }]);
    expect(t.columns[0].type).toBe("TEXT");
    expect(t.columns[1].type).toBe("TEXT");
  });

  it("regression: type-infers a column whose first non-null value is past row 50 (sparse columns)", () => {
    // Old code only sampled the first 50 rows; a column populated only at
    // index 60 was misclassified as TEXT and stored as a string. New cap is
    // 500. Mirrors the bug ada catches in tests/services/test_sql_agent_sparse_columns.py.
    const rows = Array.from({ length: 200 }, (_, i) =>
      i === 60 ? { x: 5 } : { x: null },
    );
    expect(analyzeTable("p", rows).columns[0].type).toBe("INTEGER");
  });

  it("regression: dedupes columns that sanitize to the same name (case-only / separator-only collisions)", () => {
    // ada equivalent: handle_duplicate_columns_names. SQLite would reject
    // CREATE TABLE with duplicate columns; our sanitization (lowercasing,
    // non-identifier→`_`) routinely collides keys that differ only in case
    // (`a` vs `A`) or separator (`foo bar` vs `foo-bar`). Suffix duplicates.
    const t = analyzeTable("p", [{ a: 1, A: 2, "foo bar": 3, "foo-bar": 4 }]);
    const names = t.columns.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(["a", "a_2", "foo_bar", "foo_bar_2"]);
    // originalName preserved per column so insertion still pulls correct values
    expect(t.columns.map((c) => c.originalName)).toEqual(["a", "A", "foo bar", "foo-bar"]);
  });

  it("documented limit: rows beyond the 500-row cap can still fall back to TEXT", () => {
    // Trade-off: linear scan would be O(N×K). The 500-row cap is the
    // pragmatic middle ground — typical widget payloads are well under it.
    // If a column is null for the first 500 rows, the type stays TEXT.
    const rows = Array.from({ length: 600 }, (_, i) =>
      i === 599 ? { x: 5 } : { x: null },
    );
    expect(analyzeTable("p", rows).columns[0].type).toBe("TEXT");
  });

  it("preserves originalName even when sanitized differs", () => {
    const t = analyzeTable("My Table", [{ "Total ($)": 1 }]);
    expect(t.tableName).toBe("my_table");
    expect(t.columns[0].originalName).toBe("Total ($)");
    expect(t.columns[0].name).not.toContain(" ");
  });

  it("falls back tableName to 'data' when sanitization yields empty string", () => {
    expect(analyzeTable("", [{ a: 1 }]).tableName).toBe("data");
  });

  it("returns rowCount = 0 with no columns when input is empty", () => {
    const t = analyzeTable("x", []);
    expect(t.rowCount).toBe(0);
    expect(t.columns).toEqual([]);
  });
});

describe("sanitizeRowKeys", () => {
  it("maps raw row keys to the same sanitized names analyzeTable reports", () => {
    const rows = [
      { startDate: "2026-01-01", "Volume 24hr": 5, title: "a" },
      { startDate: "2026-02-01", "Volume 24hr": 7, title: "b" },
    ];
    const out = sanitizeRowKeys("Home Cards", rows);
    expect(out).toEqual([
      { startdate: "2026-01-01", volume_24hr: 5, title: "a" },
      { startdate: "2026-02-01", volume_24hr: 7, title: "b" },
    ]);
    // Original rows untouched.
    expect(Object.keys(rows[0])).toContain("startDate");
  });

  it("disambiguates case-colliding keys exactly like analyzeTable", () => {
    const rows = [{ a: 1, A: 2 }];
    const out = sanitizeRowKeys("t", rows);
    expect(out).toEqual([{ a: 1, a_2: 2 }]);
  });
});

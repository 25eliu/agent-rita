import { describe, it, expect } from "bun:test";
import { readParseAs, routeForParseAs } from "../../../../src/widgets/parse-as";

describe("readParseAs", () => {
  it("returns the canonical lowercased value for valid kinds", () => {
    expect(readParseAs({ data_format: { parse_as: "TABLE" } })).toBe("table");
    expect(readParseAs({ data_format: { parse_as: "Chart" } })).toBe("chart");
    expect(readParseAs({ data_format: { parse_as: "text" } })).toBe("text");
    expect(readParseAs({ data_format: { parse_as: "html" } })).toBe("html");
    expect(readParseAs({ data_format: { parse_as: "snowflake_query" } })).toBe("snowflake_query");
    expect(readParseAs({ data_format: { parse_as: "snowflake_python" } })).toBe("snowflake_python");
  });

  it("returns null for unknown kinds", () => {
    expect(readParseAs({ data_format: { parse_as: "csv" } })).toBeNull();
    expect(readParseAs({ data_format: { parse_as: "" } })).toBeNull();
  });

  it("returns null when parse_as is missing or non-string", () => {
    expect(readParseAs({ data_format: {} })).toBeNull();
    expect(readParseAs({})).toBeNull();
    expect(readParseAs({ data_format: { parse_as: 42 } })).toBeNull();
  });
});

describe("routeForParseAs", () => {
  it("table and chart route to SQLite only", () => {
    expect(routeForParseAs("table")).toEqual({
      toSqlite: true,
      asText: false,
      brief: false,
      asCodeArtifact: null,
    });
    expect(routeForParseAs("chart")).toEqual({
      toSqlite: true,
      asText: false,
      brief: false,
      asCodeArtifact: null,
    });
  });

  it("text routes to plain text only", () => {
    expect(routeForParseAs("text")).toEqual({
      toSqlite: false,
      asText: true,
      brief: false,
      asCodeArtifact: null,
    });
  });

  it("html routes to brief description", () => {
    expect(routeForParseAs("html")).toEqual({
      toSqlite: false,
      asText: false,
      brief: true,
      asCodeArtifact: null,
    });
  });

  it("snowflake_query routes to code artifact", () => {
    expect(routeForParseAs("snowflake_query")).toEqual({
      toSqlite: false,
      asText: false,
      brief: false,
      asCodeArtifact: "snowflake_query",
    });
  });

  it("snowflake_python routes to code artifact", () => {
    expect(routeForParseAs("snowflake_python")).toEqual({
      toSqlite: false,
      asText: false,
      brief: false,
      asCodeArtifact: "snowflake_python",
    });
  });

  it("null falls back to dual SQLite + text route", () => {
    expect(routeForParseAs(null)).toEqual({
      toSqlite: true,
      asText: true,
      brief: false,
      asCodeArtifact: null,
    });
  });
});

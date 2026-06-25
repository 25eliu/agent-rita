export type ParseAs =
  | "table"
  | "chart"
  | "text"
  | "html"
  | "snowflake_query"
  | "snowflake_python";

export function readParseAs(item: { data_format?: Record<string, unknown> }): ParseAs | null {
  const raw = item.data_format?.parse_as;
  if (typeof raw !== "string") return null;
  const v = raw.toLowerCase();
  switch (v) {
    case "table":
    case "chart":
    case "text":
    case "html":
    case "snowflake_query":
    case "snowflake_python":
      return v;
    default:
      return null;
  }
}

export interface ParseAsRoute {
  /** Load into SQLite as a structured table. */
  toSqlite: boolean;
  /** Inject content as raw text into model context. */
  asText: boolean;
  /** Show as a brief description placeholder rather than the full content. */
  brief: boolean;
  /** Render as a code artifact (SQL or Python). */
  asCodeArtifact: "snowflake_query" | "snowflake_python" | null;
}

export function routeForParseAs(parseAs: ParseAs | null): ParseAsRoute {
  switch (parseAs) {
    case "table":
    case "chart":
      return { toSqlite: true, asText: false, brief: false, asCodeArtifact: null };
    case "text":
      return { toSqlite: false, asText: true, brief: false, asCodeArtifact: null };
    case "html":
      return { toSqlite: false, asText: false, brief: true, asCodeArtifact: null };
    case "snowflake_query":
      return { toSqlite: false, asText: false, brief: false, asCodeArtifact: "snowflake_query" };
    case "snowflake_python":
      return { toSqlite: false, asText: false, brief: false, asCodeArtifact: "snowflake_python" };
    case null:
      // Default: try SQLite for structured JSON arrays; fall through to text otherwise.
      return { toSqlite: true, asText: true, brief: false, asCodeArtifact: null };
  }
}

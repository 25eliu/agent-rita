import { analyzeTable, type TableInfo } from "../sql/loader";
import type { CopilotArtifact, Widget } from "../protocol/types";
import type { WidgetItem } from "../widgets/parse";

export interface ToolProgressStatus {
  message: string;
  eventType?: "INFO" | "WARNING" | "ERROR";
  details?: Record<string, unknown> | Array<Record<string, unknown>> | string;
  artifacts?: CopilotArtifact[];
  generic?: boolean;
}

interface ToolStatusOptions {
  isMcp?: boolean;
  actualToolName?: string;
}

const MAX_SQL_PREVIEW = 180;
const MAX_STRING_PREVIEW = 2_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_STATUS_TABLE_ROWS = 1_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncateString(value: string, max = MAX_STRING_PREVIEW): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}... [truncated, ${value.length} chars total]`;
}

function compactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncateString(value);
  if (typeof value !== "object" || value == null) return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => compactValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return items;
  }
  if (depth > 2) return "[object]";
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, val] of entries.slice(0, MAX_OBJECT_KEYS)) {
    out[key] = compactValue(val, depth + 1);
  }
  if (entries.length > MAX_OBJECT_KEYS) out.__truncated_keys = entries.length - MAX_OBJECT_KEYS;
  return out;
}

function previewOutput(output: unknown): string {
  if (typeof output === "string") return truncateString(output, 4_000);
  try {
    return truncateString(JSON.stringify(output, null, 2), 4_000);
  } catch {
    return truncateString(String(output), 4_000);
  }
}

function compactSql(sql: unknown): string | undefined {
  if (typeof sql !== "string") return undefined;
  return sql.replace(/\s+/g, " ").trim().slice(0, MAX_SQL_PREVIEW);
}

function fullSql(sql: unknown): string | undefined {
  if (typeof sql !== "string") return undefined;
  return sql.replace(/\r\n?/g, "\n").trim();
}

function sqlDetails(sql: string): string {
  return `\`\`\`sql\n${sql}\n\`\`\``;
}

function fullCode(code: unknown): string | undefined {
  if (typeof code !== "string") return undefined;
  return code.replace(/\r\n?/g, "\n").trim();
}

function pythonDetails(code: string): string {
  return `\`\`\`python\n${code}\n\`\`\``;
}

function htmlDetails(code: string): string {
  return `\`\`\`html\n${code}\n\`\`\``;
}

function mermaidDetails(code: string): string {
  return `\`\`\`mermaid\n${code}\n\`\`\``;
}

function displaySummary(input: Record<string, unknown>): string | undefined {
  const raw = asString(input.display_summary);
  const trimmed = raw?.trim();
  return trimmed ? truncateString(trimmed, 220) : undefined;
}

function inputParams(input: unknown): unknown {
  const record = asRecord(input);
  if (Object.keys(record).length === 0) return compactValue(input);
  const { display_summary: _displaySummary, ...rest } = record;
  return compactValue(rest);
}

function suppliedInputParams(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "display_summary" || value == null || value === "") continue;
    out[key] = compactValue(value);
  }
  return out;
}

function widgetConfigParams(configValue: unknown): Record<string, unknown> {
  const config = asRecord(configValue);
  return {
    ...asRecord(config.data_args),
    ...asRecord(config.ui_args),
  };
}

function navigationTabs(input: Record<string, unknown>): string[] {
  const tabs = Array.isArray(input.tabs) ? input.tabs : [];
  return tabs
    .map((tab) => asString(asRecord(tab).name))
    .filter((name): name is string => !!name);
}

function navigationRenameTabs(input: Record<string, unknown>): string[] {
  const renameMap = asRecord(input.rename_map);
  return Object.entries(renameMap)
    .map(([from, to]) => `${from} -> ${String(to)}`)
    .filter(Boolean);
}

function quotedList(values: string[], max = 4): string {
  if (values.length === 0) return "";
  const head = values.slice(0, max).map((v) => `"${v}"`);
  if (values.length > max) head.push(`${values.length - max} more`);
  return head.join(", ");
}

function displayIdentifier(raw: string): string {
  const acronyms = new Set(["api", "capex", "co2", "esg", "eu", "kpi", "ltifr", "mcp", "meur", "mwh", "sql", "ssrm"]);
  return raw
    .replace(/^ctx_/, "")
    .replace(/_table$/, "")
    .replace(/__+/g, "_")
    .split("_")
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (acronyms.has(lower)) return lower.toUpperCase();
      if (lower === "tco2e") return "tCO2e";
      return lower[0].toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function displayTableName(raw: unknown): string | undefined {
  const name = asString(raw);
  return name ? displayIdentifier(name) : undefined;
}

function catalogWidgetName(record: Record<string, unknown>): string | undefined {
  return asString(record.widget_name) ?? asString(record.name);
}

function widgetNameForStatus(record: Record<string, unknown>): string | undefined {
  const widgetName = catalogWidgetName(record);
  if (widgetName) return widgetName;
  const widgetId = asString(record.widget_id);
  return widgetId ? displayIdentifier(widgetId) : undefined;
}

function quotedName(name: string | undefined, fallback: string): string {
  return name ? `"${name}"` : fallback;
}

function baseDetails(
  toolName: string,
  input: unknown,
  phase: "call" | "output" | "thinking",
  category: string,
  options: ToolStatusOptions = {},
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    phase,
    category,
    tool_name: toolName,
    input_params: inputParams(input),
  };
  if (options.actualToolName && options.actualToolName !== toolName) {
    details.actual_tool_name = options.actualToolName;
  }
  const summary = displaySummary(asRecord(input));
  if (summary) details.display_summary = summary;
  return details;
}

function toolDisplayName(toolName: string, options: ToolStatusOptions): string {
  return options.actualToolName ?? toolName;
}

function isExecuteCodeToolName(toolName: string, options: ToolStatusOptions = {}): boolean {
  const displayName = toolDisplayName(toolName, options);
  return [toolName, displayName].some(
    (name) => name === "execute_code" || name.endsWith("_execute_code"),
  );
}

function isMermaidToolName(toolName: string, options: ToolStatusOptions = {}): boolean {
  const displayName = toolDisplayName(toolName, options);
  return [toolName, displayName].some(
    (name) => name === "mermaid_diagram" || name.endsWith("_mermaid_diagram"),
  );
}

function isWebSearchTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  if (normalized === "search_widgets") return false;
  return (
    /web[_-]?search/.test(normalized) ||
    /search[_-]?web/.test(normalized) ||
    /internet[_-]?search/.test(normalized) ||
    /search[_-]?internet/.test(normalized) ||
    /news[_-]?search/.test(normalized) ||
    normalized === "search_query"
  );
}

function searchQuery(input: unknown): string | undefined {
  const record = asRecord(input);
  const direct =
    asString(record.query) ??
    asString(record.q) ??
    asString(record.search_query) ??
    asString(record.term);
  if (direct) return truncateString(direct, 220);
  const queries = Array.isArray(record.queries) ? record.queries : undefined;
  const first = queries?.map((item) => asString(item) ?? asString(asRecord(item).q)).find(Boolean);
  return first ? truncateString(first, 220) : undefined;
}

function callCategory(toolName: string, options: ToolStatusOptions): "tool_call" | "mcp_tool" | "web_search" {
  if (isWebSearchTool(toolDisplayName(toolName, options))) return "web_search";
  if (options.isMcp) return "mcp_tool";
  return "tool_call";
}

function startSummary(toolName: string, input: unknown, options: ToolStatusOptions): string {
  const record = asRecord(input);
  const summary = displaySummary(record);
  if (summary) return summary;
  const displayName = toolDisplayName(toolName, options);
  if (isExecuteCodeToolName(toolName, options)) return "Running Python code";
  if (isWebSearchTool(displayName)) {
    const query = searchQuery(input);
    return query ? `Searching "${query}"` : `Searching with ${displayName}`;
  }
  switch (toolName) {
    case "search_widgets":
      return `Searching widgets${asString(record.query) ? ` for "${asString(record.query)}"` : ""}`;
    case "list_available_widgets": {
      const origin = asString(record.origin);
      const backend = asString(record.backend_name) ?? asString(record.backend_id);
      return origin
        ? `Listing ${origin} widgets`
        : backend
          ? `Listing widgets from ${backend}`
          : "Listing available widgets";
    }
    case "peek_table":
      return `Previewing table ${displayTableName(record.table_name) ? `"${displayTableName(record.table_name)}"` : "rows"}`;
    case "peek_column_values":
      return `Inspecting values for "${asString(record.column) ?? "column"}"`;
    case "execute_sql":
      return "Running SQL against loaded tables";
    case "execute_code":
      return "Running Python code";
    case "create_artifact": {
      const artifact = artifactDescription(record);
      return `Rendering ${artifact.noun}${artifact.name ? ` "${artifact.name}"` : ""}`;
    }
    case "get_widget_data":
      return "Loading selected widget data";
    case "get_workspace_snapshot":
      return "Reading current workspace state";
    case "get_widget_schema": {
      const widgetName = widgetNameForStatus(record);
      return widgetName ? `Loading schema for ${widgetName}` : "Loading widget schema";
    }
    case "get_params_options":
      return `Loading options for ${asString(record.param_name) ?? "widget parameter"}`;
    case "read_widget":
      return `Reading ${quotedName(catalogWidgetName(record) ?? asString(record.widget_name), "dashboard widget")}`;
    case "add_widget_to_dashboard":
      return `Adding ${quotedName(catalogWidgetName(record), "selected widget")} to dashboard`;
    case "update_widget_in_dashboard":
      return `Updating ${quotedName(catalogWidgetName(record), "dashboard widget")}`;
    case "delete_widget":
      return `Removing ${quotedName(catalogWidgetName(record) ?? asString(record.widget_uuid), "dashboard widget")}`;
    case "manage_dashboard": {
      const operation = asString(record.operation);
      if (operation === "create") return `Creating dashboard${asString(record.name) ? ` "${asString(record.name)}"` : ""}`;
      if (operation === "update") return `Updating dashboard${asString(record.name) ? ` "${asString(record.name)}"` : ""}`;
      return "Reading dashboard";
    }
    case "update_dashboard_layout":
      return `Updating layout for ${quotedName(asString(record.widget_name) ?? asString(record.widget_uuid), "dashboard widget")}`;
    case "manage_navigation_bar": {
      const operation = asString(record.operation);
      if (operation === "add_tabs") return "Adding dashboard tabs";
      if (operation === "create") return "Creating dashboard navigation";
      if (operation === "remove_tabs") return "Removing dashboard tabs";
      if (operation === "rename_tabs") return "Renaming dashboard tabs";
      return "Updating dashboard navigation";
    }
    case "add_generative_widget": {
      const widgetType = asString(record.widget_type);
      const name = asString(record.name);
      return `Adding ${name ? `"${name}" ` : ""}${widgetType ? `${widgetType} ` : ""}widget`;
    }
    case "assign_tasks_to_agents": {
      const tasks = Array.isArray(record.task_requests) ? record.task_requests.length : undefined;
      return tasks ? `Assigning ${tasks} agent task${tasks === 1 ? "" : "s"}` : "Assigning agent tasks";
    }
    case "navigate_workspace": {
      const operation = asString(record.operation);
      return operation === "tab" ? "Navigating to workspace tab" : "Navigating workspace";
    }
    case "manage_backends": {
      const operation = asString(record.operation);
      if (operation === "list") return "Listing workspace backends";
      if (operation === "refresh") return "Refreshing workspace backend";
      if (operation === "add") return `Adding backend${asString(record.name) ? ` "${asString(record.name)}"` : ""}`;
      if (operation === "update") return "Updating workspace backend";
      if (operation === "remove") return "Removing workspace backend";
      return "Managing workspace backends";
    }
    case "manage_apps": {
      const operation = asString(record.operation);
      if (operation === "list") return "Listing backend apps";
      if (operation === "read") return `Reading app${asString(record.app_name) ? ` "${asString(record.app_name)}"` : ""}`;
      if (operation === "instantiate") return `Creating dashboard from app${asString(record.app_name) ? ` "${asString(record.app_name)}"` : ""}`;
      return "Managing backend apps";
    }
    case "get_skill_content":
      return "Loading skill instructions";
    case "create_table_from_text":
      return "Extracting table from text";
    case "create_html_artifact":
      return "Rendering HTML artifact";
    default:
      return `Calling ${displayName}`;
  }
}

function callMessage(toolName: string, input: unknown, options: ToolStatusOptions): string {
  return startSummary(toolName, input, options);
}

function artifactDescription(input: Record<string, unknown>): {
  noun: string;
  name?: string;
  source?: string;
} {
  const artifact = asRecord(input.artifact);
  const type = asString(artifact.type);
  const name = asString(artifact.name);
  if (type === "chart") {
    const chartType = asString(artifact.chartType);
    return {
      noun: chartType ? `${chartType} chart` : "chart",
      name,
      source: asString(input.from_table_id) ?? compactSql(input.sql),
    };
  }
  if (type === "table") {
    return { noun: "table artifact", name, source: asString(input.from_table_id) ?? compactSql(input.sql) };
  }
  return { noun: "artifact", name, source: asString(input.from_table_id) ?? compactSql(input.sql) };
}

export function formatToolStartStatus(
  toolName: string,
  input: unknown,
  options: ToolStatusOptions = {},
): ToolProgressStatus {
  const record = asRecord(input);
  const category = callCategory(toolName, options);
  const details = baseDetails(toolName, input, "call", category, options);
  const message = callMessage(toolName, input, options);
  const statusToolName = isExecuteCodeToolName(toolName, options) ? "execute_code" : toolName;
  if (isMermaidToolName(toolName, options)) {
    const code = fullCode(record.code) ?? "(missing Mermaid code)";
    return {
      message,
      details: mermaidDetails(code),
    };
  }
  if (options.isMcp && !isExecuteCodeToolName(toolName, options)) {
    const supplied = suppliedInputParams(record);
    return {
      message,
      ...(Object.keys(supplied).length > 0 ? { details: supplied } : {}),
    };
  }

  switch (statusToolName) {
    case "search_widgets": {
      const query = asString(record.query) ?? "";
      return {
        message,
        details: { query },
      };
    }
    case "list_available_widgets": {
      const supplied = suppliedInputParams(record);
      return {
        message,
        ...(Object.keys(supplied).length > 0 ? { details: supplied } : {}),
      };
    }
    case "get_workspace_snapshot": {
      return {
        message,
      };
    }
    case "peek_table": {
      const limit = asNumber(record.limit) ?? 10;
      return {
        message,
        details: { limit },
      };
    }
    case "peek_column_values": {
      const column = asString(record.column) ?? "(unknown column)";
      const table = asString(record.table_name);
      return {
        message,
        details: { ...details, column, table_name: table ?? null },
      };
    }
    case "execute_sql": {
      const sql = fullSql(record.sql) ?? "(missing SQL)";
      return {
        message,
        details: sqlDetails(sql),
      };
    }
    case "execute_code": {
      const code = fullCode(record.code) ?? "(missing Python code)";
      return {
        message,
        details: pythonDetails(code),
      };
    }
    case "create_artifact": {
      const sql = fullSql(record.sql);
      if (sql) {
        return {
          message,
          details: sqlDetails(sql),
        };
      }
      return {
        message,
      };
    }
    case "add_widget_to_dashboard": {
      const config = asRecord(record.config);
      const params = asRecord(config.data_args);
      return {
        message,
        details: {
          origin: asString(record.origin) ?? null,
          widget_name: catalogWidgetName(record) ?? null,
          params,
        },
      };
    }
    case "update_widget_in_dashboard": {
      const params = widgetConfigParams(record.config);
      return {
        message,
        ...(Object.keys(params).length > 0 ? { details: params } : {}),
      };
    }
    case "get_widget_data": {
      const widgets = Array.isArray(record.widgets) ? record.widgets : [];
      const labels = widgets
        .map((w) => asString(asRecord(w).widget_uuid))
        .filter((v): v is string => !!v);
      return {
        message,
        details: { ...details, widget_uuids: labels },
      };
    }
    case "get_widget_schema": {
      return {
        message,
        details: {
          origin: asString(record.origin) ?? null,
          widget_name: widgetNameForStatus(record) ?? null,
        },
      };
    }
    case "manage_dashboard": {
      return {
        message,
      };
    }
    case "manage_navigation_bar": {
      const operation = asString(record.operation);
      const tabs = operation === "rename_tabs"
        ? navigationRenameTabs(record)
        : navigationTabs(record);
      return {
        message,
        ...(tabs.length > 0 ? { details: tabs.join(", ") } : {}),
      };
    }
    case "enhance_prompt": {
      return {
        message,
        details: asString(record.query),
      };
    }
    case "get_skill_content": {
      const slug = asString(record.slug) ?? "unknown";
      const reason = asString(record.reason);
      return {
        message: `Loading skill "${slug}"`,
        details: reason,
      };
    }
    case "_llm_think":
      return {
        message: displayText(asString(record.summary) ?? "planning the next steps"),
        details,
      };
    case "create_table_from_text":
      return {
        message,
        details,
      };
    case "create_html_artifact":
      return {
        message,
        details: htmlDetails(fullCode(record.html) ?? "(missing HTML)"),
      };
    default:
      return {
        message,
        details,
      };
  }
}

function validationError(errorText: string): string {
  const match = errorText.match(/Error message:\s*([\s\S]*)$/);
  return truncateString((match?.[1] ?? errorText).trim(), 2_000);
}

function conciseValidationError(errorText: string): string {
  const raw = validationError(errorText);
  try {
    const issues = JSON.parse(raw);
    if (!Array.isArray(issues)) return raw;
    const messages = issues
      .map((issue) => {
        const record = asRecord(issue);
        const message = asString(record.message);
        if (!message) return null;
        const path = Array.isArray(record.path)
          ? record.path.map((part) => String(part)).filter(Boolean).join(".")
          : "";
        return path ? `${path}: ${message}` : message;
      })
      .filter((message): message is string => !!message);
    return messages.length ? truncateString(messages.join("; "), 2_000) : raw;
  } catch {
    return raw;
  }
}

export function formatToolInputRejectedStatus(
  toolName: string,
  input: unknown,
  errorText: string,
  options: ToolStatusOptions = {},
): ToolProgressStatus {
  const details: Record<string, unknown> = {
    validation_error: validationError(errorText),
  };
  if (options.actualToolName && options.actualToolName !== toolName) {
    details.actual_tool_name = options.actualToolName;
  }
  if (toolName === "create_artifact") {
    return {
      message: "Input rejected",
      eventType: "WARNING",
      details: conciseValidationError(errorText),
    };
  }
  if (toolName === "execute_code") {
    const code = fullCode(asRecord(input).code);
    return {
      message: "Input rejected",
      eventType: "WARNING",
      details: code ? pythonDetails(code) : conciseValidationError(errorText),
    };
  }
  if (toolName === "get_widget_data") {
    return {
      message: "Input rejected",
      eventType: "WARNING",
      details: conciseValidationError(errorText),
    };
  }
  details.input = inputParams(input);
  return {
    message: "Input rejected",
    eventType: "WARNING",
    details,
  };
}

function tableArtifact(
  name: string,
  description: string,
  rows: Record<string, unknown>[] | null,
): CopilotArtifact[] | undefined {
  if (!rows || rows.length === 0) return undefined;
  const shownRows = rows.slice(0, MAX_STATUS_TABLE_ROWS);
  const renderedDescription = rows.length > shownRows.length
    ? `${description} (showing first ${shownRows.length} of ${rows.length} rows).`
    : description;
  return [{
    type: "table",
    uuid: crypto.randomUUID(),
    name,
    description: renderedDescription,
    content: shownRows,
  }];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textArtifact(item: WidgetItem): CopilotArtifact[] | undefined {
  const content = item.content.trim();
  if (!content) return undefined;

  return [{
    type: "html",
    uuid: crypto.randomUUID(),
    name: item.name,
    description: `Content loaded from ${item.name}`,
    content:
      `<article style="font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
      `line-height:1.5;color:#111827;padding:16px;max-width:900px;">` +
      `<pre style="white-space:pre-wrap;word-break:break-word;font:inherit;margin:0;">${escapeHtml(content)}</pre>` +
      `</article>`,
  }];
}

function summarizeSearchWidgets(output: unknown, input: unknown): Partial<ToolProgressStatus> | null {
  const record = asRecord(output);
  const matches = Array.isArray(record.matches) ? record.matches : null;
  if (!matches) return null;
  const total = asNumber(record.total) ?? matches.length;
  const query = asString(asRecord(input).query) ?? "";
  const artifacts = widgetMatchArtifacts(matches, total);
  const shown = matches.length;
  return {
    message:
      total === 0
        ? `No widgets matched${query ? ` "${query}"` : ""}.`
        : shown < total
          ? `Found ${total} widget matches (showing ${shown}).`
          : `Found ${total} widget match${total === 1 ? "" : "es"}.`,
    ...(artifacts ? { artifacts } : {}),
  };
}

function displayParams(params: unknown): Record<string, unknown> {
  if (!params) return {};
  if (Array.isArray(params)) {
    return Object.fromEntries(
      params
        .map((param) => {
          if (typeof param !== "string") return null;
          const [left, ...valueParts] = param.split("=");
          const name = left.split(":")[0]?.trim();
          if (!name) return null;
          return [name, widgetDetailValue(valueParts.join("="))] as const;
        })
        .filter((entry): entry is readonly [string, unknown] => entry != null),
    );
  }
  if (typeof params === "object") {
    return Object.fromEntries(
      Object.entries(params as Record<string, unknown>).map(([key, value]) => [key, widgetDetailValue(value)]),
    );
  }
  return {};
}

function widgetMatchRows(matches: unknown[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const item = asRecord(match);
    const name = asString(item.name);
    if (!name) continue;
    const backend =
      asString(item.backend_name) ??
      asString(item.backend) ??
      asString(item.origin) ??
      null;
    const description = asString(item.description) ?? null;
    const key = JSON.stringify([backend, name, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ backend, name, description });
  }
  return rows;
}

function widgetMatchArtifacts(matches: unknown[], total?: number): CopilotArtifact[] | undefined {
  const rows = widgetMatchRows(matches);
  if (rows.length === 0) return undefined;
  return [{
    type: "table",
    uuid: crypto.randomUUID(),
    name: "Widget Matches",
    description:
      total && total > rows.length
        ? `Showing ${rows.length} of ${total} widgets matching the search query.`
        : "Widgets matching the search query.",
    content: rows,
  }];
}

function outputBaseMessage(
  toolName: string,
  input: unknown,
  options: ToolStatusOptions,
): string {
  return toolDisplayName(toolName, options);
}

function artifactResultMessage(output: unknown): string | null {
  if (typeof output !== "string") return null;
  const match = output.match(/^Created (table|chart) artifact "([^"]+)" from (\d+) rows?\./);
  if (!match) return null;
  const [, kind, name, countText] = match;
  const count = Number(countText);
  const rowWord = count === 1 ? "row" : "rows";
  return `Rendered ${kind} artifact "${name}" from ${count} ${rowWord}.`;
}

function artifactFailed(output: unknown): boolean {
  if (typeof output !== "string") return false;
  return output.startsWith("Error:") || output.startsWith("SQL error:") || output.startsWith("No rows");
}

export function formatToolResultStatus(
  toolName: string,
  input: unknown,
  output: unknown,
  options: ToolStatusOptions = {},
): ToolProgressStatus {
  const outputMessage = outputBaseMessage(toolName, input, options);
  const details = {
    ...baseDetails(toolName, input, "output", "tool_output", options),
    output_preview: previewOutput(output),
  };
  if (toolName === "search_widgets") {
    const summary = summarizeSearchWidgets(output, input);
    return {
      message: summary?.message ?? `${outputMessage} returned a result`,
      eventType: "INFO",
      details: undefined,
      artifacts: summary?.artifacts,
    };
  }
  if (toolName === "enhance_prompt") {
    return {
      message: `${outputMessage} returned a result`,
      eventType: "INFO",
      details: previewOutput(output),
    };
  }
  if (toolName === "create_artifact") {
    const message = artifactResultMessage(output);
    if (message) {
      return {
        message,
        eventType: "INFO",
      };
    }
    if (artifactFailed(output)) {
      return {
        message: "Artifact rendering failed",
        eventType: "INFO",
        details,
        generic: true,
      };
    }
  }
  return {
    message: `${outputMessage} returned a result`,
    eventType: "INFO",
    details,
    generic: true,
  };
}

function displayText(text: string): string {
  if (!text) return text;
  return text[0].toUpperCase() + text.slice(1);
}

export function formatWidgetDataLoadedStatuses(
  widgetItems: WidgetItem[],
  newTables: TableInfo[],
  options: {
    cached?: boolean;
    tableRows?: Map<string, Record<string, unknown>[]>;
  } = {},
): ToolProgressStatus[] {
  const structuredTables = structuredWidgetTables(widgetItems);
  const structuredByUuid = new Map(structuredTables.map((entry) => [entry.uuid, entry] as const));
  const newTableByName = new Map(newTables.map((table) => [table.tableName, table] as const));
  const structuredRowsByTable = new Map(
    structuredTables.map(({ table, rows }) => [table.tableName, rows] as const),
  );

  return widgetItems.map((item) => {
    const structured = structuredByUuid.get(item.uuid);
    const displayTables = structured
      ? [newTableByName.get(structured.table.tableName) ?? structured.table]
      : [];
    const tableDisplayNames = new Map(
      structured ? [[structured.table.tableName, structured.name] as const] : [],
    );
    const tableSummaries = displayTables.map((table) => ({
      table_name: table.tableName,
      display_name: tableDisplayNames.get(table.tableName) ?? displayIdentifier(table.tableName),
      rows: table.rowCount,
      columns: table.columns.map((col) => col.name),
    }));
    const tableArtifactEntries = displayTables.flatMap((table) => {
      const displayName = tableDisplayNames.get(table.tableName) ?? displayIdentifier(table.tableName);
      const artifacts = tableArtifact(
        displayName,
        `Rows loaded from ${displayName}`,
        options.tableRows?.get(table.tableName) ?? structuredRowsByTable.get(table.tableName) ?? null,
      );
      return artifacts ? artifacts.map((artifact) => ({ tableName: table.tableName, artifact })) : [];
    });
    const textArtifacts = structured ? [] : textArtifact(item) ?? [];
    const artifacts = [...tableArtifactEntries.map(({ artifact }) => artifact), ...textArtifacts];
    const artifactedTables = new Set(tableArtifactEntries.map(({ tableName }) => tableName));
    const allTablesRenderedAsArtifacts =
      displayTables.length > 0 && displayTables.every((table) => artifactedTables.has(table.tableName));
    const hasNonTabularWidget = !structured;
    const shouldUseArtifactsOnly =
      artifacts.length > 0 &&
      ((allTablesRenderedAsArtifacts && !hasNonTabularWidget) || (hasNonTabularWidget && displayTables.length === 0));

    return {
      message: `${options.cached ? "Using cached" : "Loaded"} "${item.name}" data.`,
      details: shouldUseArtifactsOnly ? undefined : {
        phase: "output",
        category: "tool_output",
        tool_name: "get_widget_data",
        widget: widgetItemDetails(item),
        ...(tableSummaries.length > 0 ? { tables: tableSummaries } : {}),
      },
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
  });
}

export function formatWidgetDataLoadedStatus(
  widgetItems: WidgetItem[],
  newTables: TableInfo[],
  options: {
    cached?: boolean;
    tableRows?: Map<string, Record<string, unknown>[]>;
  } = {},
): ToolProgressStatus {
  const statuses = formatWidgetDataLoadedStatuses(widgetItems, newTables, options);
  if (statuses.length === 1) return statuses[0];
  const names = widgetItems.map((item) => item.name);
  const artifacts = statuses.flatMap((status) => status.artifacts ?? []);
  const details = statuses
    .map((status) => status.details)
    .filter((detail): detail is Record<string, unknown> =>
      !!detail && typeof detail === "object" && !Array.isArray(detail)
    );
  return {
    message: `${options.cached ? "Using cached" : "Loaded"} ${quotedList(names)}.`,
    details: details.length === 0 ? undefined : details,
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

function structuredWidgetTables(
  widgetItems: WidgetItem[],
): Array<{ table: TableInfo; rows: Record<string, unknown>[]; name: string; uuid: string }> {
  const out: Array<{ table: TableInfo; rows: Record<string, unknown>[]; name: string; uuid: string }> = [];
  for (const item of widgetItems) {
    if (!item.content.trim()) continue;
    try {
      const rows = JSON.parse(item.content);
      if (
        Array.isArray(rows) &&
        rows.length > 0 &&
        rows.every((row) => row && typeof row === "object" && !Array.isArray(row))
      ) {
        out.push({
          table: analyzeTable(item.name, rows as Record<string, unknown>[]),
          rows: rows as Record<string, unknown>[],
          name: item.name,
          uuid: item.uuid,
        });
      }
    } catch {
      // Non-tabular widget content is still useful to the model but has no table artifact.
    }
  }
  return out;
}

function widgetParams(widget: Widget): Record<string, unknown> {
  return Object.fromEntries(
    widget.params
      .map((param) => [param.name, param.current_value ?? param.default_value])
      .filter(([, value]) => value != null),
  );
}

function widgetDetailValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (typeof value === "string" && value.includes(",")) {
    return value.split(",").map((item) => item.trim()).filter(Boolean).join(", ");
  }
  return value;
}

function widgetParamsForDisplay(widget: Widget): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(widgetParams(widget)).map(([key, value]) => [key, widgetDetailValue(value)]),
  );
}

function widgetRequestDetails(widget: Widget): Record<string, unknown> {
  const params = widgetParamsForDisplay(widget);
  return {
    backend: widget.origin,
    name: widget.name,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

function widgetItemDetails(item: WidgetItem): Record<string, unknown> {
  return {
    ...(item.widget ? widgetRequestDetails(item.widget) : { name: item.name }),
    uuid: item.uuid,
    chars: item.content.length,
    media_parts: item.parts?.length ?? 0,
  };
}

export function formatWidgetDataRequestStatus(
  widgets: Widget[],
  options: { sql?: string } = {},
): ToolProgressStatus {
  return formatWidgetDataRequestStatuses(widgets, options)[0] ?? {
    message: "Loading selected widget data",
  };
}

export function formatWidgetDataRequestStatuses(
  widgets: Widget[],
  options: { sql?: string } = {},
): ToolProgressStatus[] {
  return widgets.map((widget) => {
    const details = {
      ...widgetRequestDetails(widget),
      ...(options.sql ? { SQL: options.sql } : {}),
    };
    return {
      message: `Loading "${widget.name}"`,
      details,
    };
  });
}

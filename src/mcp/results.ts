import type { ModelMessage } from "ai";
import { z } from "zod";
import type { CopilotArtifact, SSEEvent, ToolMessage } from "../protocol/types";
import { messageArtifact } from "../protocol/events";
import { analyzeTable, type TableInfo } from "../sql/loader";
import { rememberRows } from "../agent/row-cache";
import { setPendingTable } from "../agent/pending-tables";
import { getLogger } from "../lib/logger";

const logger = getLogger(["app", "mcp", "results"]);

export interface WebCitation {
  id: string;
  type: "web";
  url: string;
  title: string;
}

export interface DocumentCitation {
  id: string;
  type: "document";
  uri: string;
  title: string;
  page?: number;
}

export type McpCitation = WebCitation | DocumentCitation;

/**
 * Typed MCP result protocol. MCP servers encode rich items as JSON strings inside
 * standard MCP text content items, using `$rita_kind` as the discriminator.
 *
 * Plain text (no `$rita_kind`) → injected as user message.
 * `$rita_kind: "artifact"` → emitted as `copilotMessageArtifact` SSE.
 * `$rita_kind: "citation"` → added to citation aggregator (optional stable id).
 * `$rita_kind: "sqlite_table"` → loaded into request-scoped SQLite + preview added.
 * `$rita_kind: "error"` → typed error injected with code prefix.
 * `$rita_kind: "model_context"` → opt-in summary that REPLACES plain text in the LLM message.
 * `$rita_kind: "sandbox_meta"` → Daytona sandbox identity from execute_code;
 *   silent (no model text), captured for the loop's delta-ship invalidation.
 */
type RitaTypedItem =
  | { $rita_kind: "artifact"; artifact: CopilotArtifact }
  | { $rita_kind: "citation"; citation: WebCitationData | DocumentCitationData }
  | { $rita_kind: "sqlite_table"; name: string; rows: Record<string, unknown>[] }
  | { $rita_kind: "error"; error: { code: string; message: string; retryable?: boolean } }
  | { $rita_kind: "model_context"; summary: string }
  | { $rita_kind: "sandbox_meta"; sandbox_id: string };

const sandboxMetaPayloadSchema = z.object({ sandbox_id: z.string().min(1) });

interface WebCitationData {
  type: "web";
  url: string;
  title: string;
  id?: string;
}

interface DocumentCitationData {
  type: "document";
  uri: string;
  title: string;
  page?: number;
  id?: string;
}

function readItemText(rawItem: unknown): string | null {
  if (!rawItem || typeof rawItem !== "object") return null;
  const item = rawItem as { content?: unknown; text?: unknown };
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  return null;
}

function tryParseJson(text: string): unknown {
  if (text.length === 0 || (text[0] !== "{" && text[0] !== "[")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asTypedItem(value: unknown): RitaTypedItem | null {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { $rita_kind?: unknown }).$rita_kind === "string"
  ) {
    return value as RitaTypedItem;
  }
  return null;
}

export interface McpResultContext {
  tables: TableInfo[];
  artifactQueue: SSEEvent[];
  citations: McpCitation[];
  messages: ModelMessage[];
  /**
   * Tables available for shipping to the compute MCP sandbox. The loop's
   * decoration step diffs this against `compute_tables_shipped` (extra_state)
   * to send only deltas on each compute tool call.
   */
  pendingTables: Map<string, Record<string, unknown>[]>;
  /**
   * Names already shipped to the compute sandbox in this chat. Mutated here
   * via `setPendingTable` when a `sqlite_table` result OVERWRITES an existing
   * `pendingTables` entry — the new rows must re-ship even if the name was
   * previously marked shipped.
   */
  tablesShipped: Set<string>;
  /**
   * Per-chat identifier from X-Trace-Id. Used to cache MCP-emitted tables
   * across requests so follow-up messages can use them without a re-fetch.
   */
  conversationId: string;
}

export interface McpResultSummary {
  toolName: string;
  serverId: string;
  textChars: number;
  outputPreview: string;
  outputRows?: Record<string, unknown>[];
  artifactCount: number;
  citationCount: number;
  tableCount: number;
  errorCount: number;
  hasModelContext: boolean;
  /**
   * Daytona sandbox identity from a `sandbox_meta` item, if one was present in
   * this result. The agent loop compares this against the prior call's id to
   * detect sandbox recreation and clear `tablesShipped`.
   */
  sandboxId: string | undefined;
}

interface Counters {
  textParts: string[];
  modelContext: string | null;
  artifactCount: number;
  citationCount: number;
  tableCount: number;
  errorCount: number;
  sandboxId: string | undefined;
}

const MAX_OUTPUT_ARTIFACT_ROWS = 100;
const MAX_OUTPUT_ARTIFACT_STRING = 2_000;
const OUTPUT_ARRAY_KEYS = ["results", "data", "items", "rows"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactOutputValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length <= MAX_OUTPUT_ARTIFACT_STRING
      ? value
      : `${value.slice(0, MAX_OUTPUT_ARTIFACT_STRING)}... [truncated, ${value.length} chars total]`;
  }
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (depth > 1) return "[object]";
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, compactOutputValue(nested, depth + 1)]),
  );
}

function rowFromValue(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, compactOutputValue(nested)]),
    );
  }
  return { value: compactOutputValue(value) };
}

function scalarMetadata(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => value === null || typeof value !== "object")
      .map(([key, value]) => [key, compactOutputValue(value)]),
  );
}

function rowsFromArray(
  values: unknown[],
  metadata: Record<string, unknown> = {},
): Record<string, unknown>[] | undefined {
  const rows = values.slice(0, MAX_OUTPUT_ARTIFACT_ROWS).map((value) => ({
    ...metadata,
    ...rowFromValue(value),
  }));
  return rows.length > 0 ? rows : undefined;
}

function outputRowsFromJson(value: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(value)) return rowsFromArray(value);
  if (isRecord(value)) {
    const metadata = scalarMetadata(value);
    for (const key of OUTPUT_ARRAY_KEYS) {
      const nested = value[key];
      if (Array.isArray(nested)) return rowsFromArray(nested, metadata);
    }
    return [rowFromValue(value)];
  }
  return [{ value: compactOutputValue(value) }];
}

function isEmptyArtifactContent(artifact: CopilotArtifact): boolean {
  const content = "content" in artifact ? artifact.content : undefined;
  return (
    content === "" ||
    content === undefined ||
    content === null ||
    (Array.isArray(content) && content.length === 0)
  );
}

/**
 * Model-facing acknowledgment that an artifact rendered for the user. The
 * artifact itself rides the SSE side-channel (`artifactQueue`), which the
 * model never sees — without this line a successful chart/table call reads
 * as "no output" and the model re-runs work that already succeeded.
 */
function artifactAckText(artifact: CopilotArtifact): string {
  return `[Artifact "${artifact.name}" (${artifact.type}) delivered to the user — already rendered in the chat, do not regenerate it]`;
}

function dispatchTyped(typed: RitaTypedItem, ctx: McpResultContext, c: Counters): void {
  switch (typed.$rita_kind) {
    case "artifact": {
      if (isEmptyArtifactContent(typed.artifact)) return;
      ctx.artifactQueue.push(messageArtifact(typed.artifact));
      c.artifactCount++;
      c.textParts.push(artifactAckText(typed.artifact));
      return;
    }

    case "citation": {
      const id = typed.citation.id ?? crypto.randomUUID();
      if (typed.citation.type === "web") {
        ctx.citations.push({ id, type: "web", url: typed.citation.url, title: typed.citation.title });
      } else {
        ctx.citations.push({
          id,
          type: "document",
          uri: typed.citation.uri,
          title: typed.citation.title,
          ...(typed.citation.page != null ? { page: typed.citation.page } : {}),
        });
      }
      c.citationCount++;
      return;
    }

    case "sqlite_table": {
      if (typed.rows.length > 0) {
        const table = analyzeTable(typed.name, typed.rows);
        ctx.tables.push(table);
        setPendingTable(table.tableName, typed.rows, ctx.pendingTables, ctx.tablesShipped);
        rememberRows(ctx.conversationId, table.tableName, typed.rows);
        c.tableCount++;
        const colLines = table.columns
          .map((col) => `  - "${col.name}" (${col.type})`)
          .join("\n");
        c.textParts.push(
          `[${table.rowCount} rows available as table "${table.tableName}" in the compute sandbox]\n` +
          `Columns:\n${colLines}\n` +
          `Query via execute_sql; for analytics or charts use execute_code with rita.show().`,
        );
      }
      return;
    }

    case "sandbox_meta": {
      // Silent: no text, no message. The agent's loop reads `summary.sandboxId`
      // to detect sandbox recreation and reset `tablesShipped`.
      const parsed = sandboxMetaPayloadSchema.safeParse({ sandbox_id: typed.sandbox_id });
      if (parsed.success) {
        c.sandboxId = parsed.data.sandbox_id;
      } else {
        logger.warn("sandbox_meta payload failed validation", {
          issues: parsed.error.issues,
        });
      }
      return;
    }

    case "error": {
      const retryable = typed.error.retryable ?? false;
      c.errorCount++;
      c.textParts.push(
        `[ERROR ${typed.error.code}${retryable ? " retryable" : ""}] ${typed.error.message}`,
      );
      return;
    }

    case "model_context": {
      // Last-wins if a tool emits multiple. Replaces plain text in the LLM message.
      c.modelContext = typed.summary;
      return;
    }
  }
}

function processPayload(text: string, ctx: McpResultContext, c: Counters): void {
  const parsed = tryParseJson(text);

  // Workspace flattens MCP `content[]` into a JSON-stringified array of text strings
  // (terminalpro `useMcpExecutor.ts`). Recurse into each element so typed items survive.
  if (Array.isArray(parsed)) {
    for (const sub of parsed) {
      if (typeof sub === "string") {
        processPayload(sub, ctx, c);
      } else {
        const typed = asTypedItem(sub);
        if (typed) dispatchTyped(typed, ctx, c);
        else c.textParts.push(JSON.stringify(sub));
      }
    }
    return;
  }

  const typed = asTypedItem(parsed);
  if (typed) {
    dispatchTyped(typed, ctx, c);
    return;
  }

  c.textParts.push(text);
}

export function processMcpResult(
  toolMsg: ToolMessage,
  ctx: McpResultContext,
): McpResultSummary {
  const toolName = (toolMsg.input_arguments?.tool_name as string) ?? "unknown";
  const serverId = (toolMsg.input_arguments?.server_id as string) ?? "unknown";

  const counters: Counters = {
    textParts: [],
    modelContext: null,
    artifactCount: 0,
    citationCount: 0,
    tableCount: 0,
    errorCount: 0,
    sandboxId: undefined,
  };

  for (const entry of toolMsg.data ?? []) {
    for (const rawItem of entry.items ?? []) {
      const text = readItemText(rawItem);
      if (text === null || text === "") continue;
      processPayload(text, ctx, counters);
    }
  }

  const { textParts, modelContext, artifactCount, citationCount, tableCount, errorCount, sandboxId } = counters;

  // model_context REPLACES plain text in the LLM message when present (opt-in).
  // Plain text falls back to concat if no model_context.
  const llmContent = modelContext ?? (textParts.length > 0 ? textParts.join("\n\n") : null);
  const parsedOutput = llmContent === null ? null : tryParseJson(llmContent);
  const outputRows = parsedOutput === null ? undefined : outputRowsFromJson(parsedOutput);
  if (llmContent !== null) {
    ctx.messages.push({
      role: "user" as const,
      content: `MCP tool result from ${toolName}:\n\n${llmContent}`,
    });
  }

  const summary: McpResultSummary = {
    toolName,
    serverId,
    textChars: (llmContent ?? "").length,
    outputPreview: (llmContent ?? "").slice(0, HISTORY_RENDER_MAX_CHARS),
    ...(outputRows ? { outputRows } : {}),
    artifactCount,
    citationCount,
    tableCount,
    errorCount,
    hasModelContext: modelContext !== null,
    sandboxId,
  };

  const { outputRows: _outputRows, ...logSummary } = summary;
  logger.info("MCP result processed", {
    ...logSummary,
    outputRowCount: outputRows?.length ?? 0,
  });
  return summary;
}

const HISTORY_RENDER_MAX_CHARS = 2_000;

/**
 * Pure, side-effect-free rendering of an execute_agent_tool result for the
 * rebuilt model history (`buildMessages`). Mirrors the model-facing text of
 * `dispatchTyped` — same kind→text mapping — but performs none of its state
 * effects: no artifactQueue pushes, no pendingTables writes, and critically
 * no `rememberRows` (re-dispatching stale history rows would corrupt the
 * cross-request row cache). That state is restored through its own channels
 * (row cache, extra_state); this function only restores the model's MEMORY
 * of what each earlier call did. Without it the model forgets every prior
 * tool outcome in the turn — it re-runs work that already succeeded and
 * repeats mistakes whose tracebacks it can no longer see.
 */
export function renderToolResultForHistory(toolMsg: ToolMessage): string | null {
  const parts: string[] = [];
  let modelContext: string | null = null;

  function visitTyped(typed: RitaTypedItem): void {
    switch (typed.$rita_kind) {
      case "artifact":
        if (!isEmptyArtifactContent(typed.artifact)) parts.push(artifactAckText(typed.artifact));
        return;
      case "sqlite_table":
        if (typed.rows.length > 0) parts.push(`[${typed.rows.length} rows loaded as table "${typed.name}"]`);
        return;
      case "error":
        parts.push(`[ERROR ${typed.error.code}] ${typed.error.message}`);
        return;
      case "model_context":
        modelContext = typed.summary;
        return;
      case "citation":
      case "sandbox_meta":
        return;
    }
  }

  function visit(text: string): void {
    const parsed = tryParseJson(text);
    // Same workspace-flattening recursion as processPayload.
    if (Array.isArray(parsed)) {
      for (const sub of parsed) {
        if (typeof sub === "string") {
          visit(sub);
        } else {
          const typed = asTypedItem(sub);
          if (typed) visitTyped(typed);
          else parts.push(JSON.stringify(sub));
        }
      }
      return;
    }
    const typed = asTypedItem(parsed);
    if (typed) visitTyped(typed);
    else parts.push(text);
  }

  for (const entry of toolMsg.data ?? []) {
    for (const rawItem of entry.items ?? []) {
      const text = readItemText(rawItem);
      if (text === null || text === "") continue;
      visit(text);
    }
  }

  const content = modelContext ?? (parts.length > 0 ? parts.join("\n\n") : null);
  if (content === null) return null;
  return content.length > HISTORY_RENDER_MAX_CHARS
    ? `${content.slice(0, HISTORY_RENDER_MAX_CHARS)}\n… [truncated]`
    : content;
}

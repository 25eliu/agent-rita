/**
 * Conversation-scoped cache of parsed widget rows. Survives across HTTP
 * requests (module-level), keyed by conversationId (X-Trace-Id from the
 * workspace). Written to by `injectWidgetData` and the `sqlite_table`
 * MCP-result handler; read at the top of `runAgentLoop` to seed
 * `pendingTables` so a follow-up message in the same chat can hit
 * `execute_sql` / `execute_code` without first round-tripping back through
 * `get_widget_data`.
 *
 * Eviction: simple TTL, mirrors `widgetDataCache` in src/agent/loop.ts.
 * No row caps and no LRU for v1 — the TTL is the only ceiling. Idle chats
 * fall out after 5 min; active ones get their timestamp bumped on every
 * write so they stay alive.
 */

import { getLogger } from "../lib/logger";
import type { Widget } from "../protocol/types";

const logger = getLogger(["app", "agent", "row-cache"]);

// 30 min — covers typical user pauses between follow-up messages. Daytona
// sandbox auto-stops after 10 min idle, so on the next compute call we'll
// re-ship from this cache (sandbox is recreated, tables reload via
// CREATE OR REPLACE). Memory cost is small: ~100KB per loaded table.
const CACHE_TTL_MS = 30 * 60 * 1000;

interface ChatEntry {
  tables: Map<string, CachedRows>;
  timestamp: number;
}

interface CachedRows {
  rows: Record<string, unknown>[];
  widgetUuid?: string;
  inputArgs?: Record<string, unknown>;
}

export interface RememberRowsOptions {
  widgetUuid?: string;
  inputArgs?: Record<string, unknown>;
}

// Persist across `bun --hot` reloads. Module-level state is reset whenever
// any source file changes; pinning the Map to globalThis preserves cached
// rows so dev iterations don't force the model to re-fetch widget data.
declare global {
  // eslint-disable-next-line no-var
  var __rita_chat_row_cache: Map<string, ChatEntry> | undefined;
}
const chatRowCache: Map<string, ChatEntry> =
  globalThis.__rita_chat_row_cache ?? (globalThis.__rita_chat_row_cache = new Map());

function isExpired(entry: ChatEntry): boolean {
  return Date.now() - entry.timestamp > CACHE_TTL_MS;
}

function compactInputArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args) return {};
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value != null && value !== ""),
  );
}

function stableInputArgsKey(args: Record<string, unknown> | undefined): string {
  const compact = compactInputArgs(args);
  return JSON.stringify(
    Object.keys(compact)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = compact[key];
        return acc;
      }, {}),
  );
}

function currentWidgetInputArgs(widget: Widget): Record<string, unknown> {
  return Object.fromEntries(
    widget.params.map((param) => [param.name, param.current_value ?? param.default_value]),
  );
}

function sanitizeName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^(\d)/, "col_$1")
    .toLowerCase();
}

function normalizeCachedRows(value: unknown): CachedRows | null {
  if (Array.isArray(value)) {
    return value.every((row) => row && typeof row === "object" && !Array.isArray(row))
      ? { rows: value as Record<string, unknown>[] }
      : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<CachedRows>;
  if (!Array.isArray(record.rows)) return null;
  return {
    rows: record.rows,
    widgetUuid: typeof record.widgetUuid === "string" ? record.widgetUuid : undefined,
    inputArgs:
      record.inputArgs && typeof record.inputArgs === "object" && !Array.isArray(record.inputArgs)
        ? record.inputArgs
        : undefined,
  };
}

function cachedRowsMatchCurrentWidget(
  tableName: string,
  cached: CachedRows,
  allWidgets?: Widget[],
): boolean {
  if (!allWidgets) return true;
  const widget = cached.widgetUuid
    ? allWidgets.find((w) => w.uuid === cached.widgetUuid)
    : allWidgets.find((w) => sanitizeName(w.name) === tableName);
  if (!widget) return true;
  if (!cached.widgetUuid && stableInputArgsKey(currentWidgetInputArgs(widget)) !== "{}") {
    return false;
  }
  return stableInputArgsKey(cached.inputArgs) === stableInputArgsKey(currentWidgetInputArgs(widget));
}

/**
 * Snapshot of cached rows for a conversation. Returns an empty Map when
 * no cache exists, the entry has expired (in which case it's also dropped),
 * or no conversationId was supplied. The returned Map is a shallow copy —
 * mutating it does not affect the cache; row arrays themselves are shared
 * by reference (callers treat them as immutable).
 */
export function getCachedRows(
  conversationId: string,
  allWidgets?: Widget[],
): Map<string, Record<string, unknown>[]> {
  if (!conversationId) return new Map();
  const entry = chatRowCache.get(conversationId);
  if (!entry) return new Map();
  if (isExpired(entry)) {
    chatRowCache.delete(conversationId);
    return new Map();
  }
  const rows = new Map<string, Record<string, unknown>[]>();
  for (const [tableName, value] of entry.tables) {
    const cached = normalizeCachedRows(value);
    if (!cached) {
      entry.tables.delete(tableName);
      continue;
    }
    if (!cachedRowsMatchCurrentWidget(tableName, cached, allWidgets)) {
      logger.debug("Skipped cached widget rows with stale params", {
        conversationId,
        tableName,
        widgetUuid: cached.widgetUuid,
        cachedInputArgs: compactInputArgs(cached.inputArgs),
      });
      continue;
    }
    rows.set(tableName, cached.rows);
  }
  return rows;
}

/**
 * Persist (tableName → rows) into the conversation's cache. Refreshes the
 * entry timestamp so chats that keep producing tables stay cached past the
 * TTL window. No-ops on missing conversationId or empty rows.
 */
export function rememberRows(
  conversationId: string,
  tableName: string,
  rows: Record<string, unknown>[],
  options: RememberRowsOptions = {},
): void {
  if (!conversationId || rows.length === 0) return;
  let entry = chatRowCache.get(conversationId);
  if (!entry || isExpired(entry)) {
    entry = { tables: new Map(), timestamp: Date.now() };
    chatRowCache.set(conversationId, entry);
  }
  entry.tables.set(tableName, {
    rows,
    widgetUuid: options.widgetUuid,
    inputArgs: options.inputArgs ? compactInputArgs(options.inputArgs) : undefined,
  });
  entry.timestamp = Date.now();
  logger.debug("Cached rows for chat", {
    conversationId,
    tableName,
    rowCount: rows.length,
    totalTablesCached: entry.tables.size,
  });
}

/**
 * Remove a table from the conversation cache when a fresh widget fetch proves
 * the old rows are stale, for example a filtered widget request returning no
 * rows. No-ops on missing cache state.
 */
export function forgetRows(
  conversationId: string,
  tableName: string,
): void {
  if (!conversationId) return;
  const entry = chatRowCache.get(conversationId);
  if (!entry) return;
  if (isExpired(entry)) {
    chatRowCache.delete(conversationId);
    return;
  }
  if (!entry.tables.delete(tableName)) return;
  entry.timestamp = Date.now();
  if (entry.tables.size === 0) {
    chatRowCache.delete(conversationId);
  }
  logger.debug("Forgot cached rows for chat", {
    conversationId,
    tableName,
    totalTablesCached: entry.tables.size,
  });
}

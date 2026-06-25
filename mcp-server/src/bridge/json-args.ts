/**
 * JSON-string argument parsers for workspace tools.
 *
 * Mirrors workspace_mcp/server.py:248-352. Tools accept JSON-stringified
 * dicts/lists/values via flat MCP arguments (because some MCP clients don't
 * deal well with nested object inputs). Each parser raises
 * `JsonArgumentError` on shape failure so the tool handler can return a
 * structured `invalid_request` ContentItem without further branching.
 */

import { errorItem, type ContentItem } from "../lib/typed";

export class JsonArgumentError extends Error {
  constructor(
    public readonly command: string,
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`${command} requires ${field} to ${reason}.`);
    this.name = "JsonArgumentError";
  }

  toContentItem(): ContentItem {
    return errorItem({
      code: "invalid_request",
      message: this.message,
      retryable: false,
    });
  }
}

export function parseJsonObject(
  command: string,
  field: string,
  raw: string | null | undefined,
): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new JsonArgumentError(command, field, `be valid JSON: ${msg}`);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new JsonArgumentError(command, field, "be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function parseJsonList(
  command: string,
  field: string,
  raw: string | null | undefined,
): Array<Record<string, unknown>> {
  if (raw === null || raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new JsonArgumentError(command, field, `be valid JSON: ${msg}`);
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))
  ) {
    throw new JsonArgumentError(command, field, "be a JSON array of objects");
  }
  return parsed as Array<Record<string, unknown>>;
}

export function parseJsonValue(
  command: string,
  field: string,
  raw: string | null | undefined,
): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new JsonArgumentError(command, field, `be valid JSON: ${msg}`);
  }
}

/**
 * `add_generative_widget` data_json accepts plain strings for note/html (not
 * required to be JSON-quoted). Mirrors workspace_mcp/server.py:355-362.
 */
export function parseGenerativeData(
  widgetType: string,
  raw: string | null | undefined,
): unknown {
  try {
    return parseJsonValue("add_generative_widget", "data_json", raw);
  } catch (err) {
    if (err instanceof JsonArgumentError) {
      if ((widgetType === "note" || widgetType === "html") && raw !== null && raw !== undefined) {
        return raw;
      }
    }
    throw err;
  }
}

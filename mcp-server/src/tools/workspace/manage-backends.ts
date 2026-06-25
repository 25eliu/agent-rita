/**
 * manage_backends — list/add/update/refresh/remove Workspace data backends.
 *
 * Mirrors workspace_mcp/server.py:1052-1123 with operation-specific
 * required-field checks and BackendEndpointHeader validation.
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";
import { invalidRequestItem } from "../../bridge/validators";
import { parseJsonList, JsonArgumentError } from "../../bridge/json-args";
import { BackendEndpointHeaderSchema } from "../../bridge/wire";
import { describeTool } from "../../bridge/instructions";

export const manageBackendsSchema = {
  operation: z
    .enum(["list", "add", "update", "refresh", "remove"])
    .describe("Operation to perform on backends."),
  backend_id: z.string().optional().describe(
    "Backend UUID. Required for update/refresh/remove.",
  ),
  name: z.string().optional().describe("Backend display name."),
  url: z.string().optional().describe("Backend base URL."),
  endpoint_headers_json: z.string().optional().describe(
    'JSON array of {"key", "value", "location"} objects ' +
      "where location is \"headers\" (default) or \"query\".",
  ),
  validate_widgets: z.boolean().optional().describe(
    "Whether to surface a warning if widgets fail to load. Defaults true on add.",
  ),
  is_openbb_platform: z.boolean().optional().describe(
    "Mark as an OpenBB Platform backend.",
  ),
} as const;

export const manageBackendsDescription = describeTool(
  "Manage Workspace data backends (the connections that power widgets).",
  "Requires operation from {list, add, update, refresh, remove}.",
  "For list, returns each backend with id, name, url, status, and widget/app/agent counts.",
  "For add, requires name and url. Optional endpoint_headers_json is a JSON array of " +
    '{"key", "value", "location"} where location is "headers" (default) or "query". ' +
    "validate_widgets defaults to true and surfaces a warning if widgets fail to load.",
  "For update, requires backend_id and at least one of name, url, or endpoint_headers_json.",
  "For refresh, requires backend_id; re-fetches widgets and templates from the backend URL.",
  "For remove, requires backend_id.",
);

export async function manageBackendsHandler(args: {
  operation: "list" | "add" | "update" | "refresh" | "remove";
  backend_id?: string;
  name?: string;
  url?: string;
  endpoint_headers_json?: string;
  validate_widgets?: boolean;
  is_openbb_platform?: boolean;
}): Promise<{ content: ContentItem[] }> {
  type EndpointHeader = {
    key: string;
    value: string;
    location: "headers" | "query";
  };
  let endpointHeaders: EndpointHeader[] | null = null;

  if (args.endpoint_headers_json !== undefined) {
    let rawHeaders: Array<Record<string, unknown>>;
    try {
      rawHeaders = parseJsonList(
        "manage_backends",
        "endpoint_headers_json",
        args.endpoint_headers_json,
      );
    } catch (err) {
      if (err instanceof JsonArgumentError) {
        return { content: [err.toContentItem()] };
      }
      throw err;
    }
    const validated: EndpointHeader[] = [];
    for (const item of rawHeaders) {
      const parsed = BackendEndpointHeaderSchema.safeParse(item);
      if (!parsed.success) {
        return {
          content: [
            invalidRequestItem(
              "manage_backends endpoint_headers_json items must be objects with " +
                "string 'key' and 'value' fields and optional 'location' as 'headers' or 'query'.",
            ),
          ],
        };
      }
      validated.push(parsed.data);
    }
    endpointHeaders = validated;
  }

  if (args.operation === "add") {
    if (!args.name || !args.url) {
      return {
        content: [
          invalidRequestItem(
            "manage_backends operation='add' requires name and url.",
          ),
        ],
      };
    }
  } else if (
    args.operation === "update" ||
    args.operation === "refresh" ||
    args.operation === "remove"
  ) {
    if (!args.backend_id) {
      return {
        content: [
          invalidRequestItem(
            `manage_backends operation='${args.operation}' requires backend_id.`,
          ),
        ],
      };
    }
    if (
      args.operation === "update" &&
      !args.name &&
      !args.url &&
      endpointHeaders === null &&
      args.is_openbb_platform === undefined
    ) {
      return {
        content: [
          invalidRequestItem(
            "manage_backends operation='update' requires at least one of " +
              "name, url, endpoint_headers_json, or is_openbb_platform.",
          ),
        ],
      };
    }
  }

  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "manage_backends",
    operation: args.operation,
    backend_id: args.backend_id ?? null,
    name: args.name ?? null,
    url: args.url ?? null,
    endpoint_headers: endpointHeaders,
    validate_widgets: args.validate_widgets ?? null,
    is_openbb_platform: args.is_openbb_platform ?? null,
  });
  return { content };
}

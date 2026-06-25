/**
 * Typed-result helpers for the rita MCP server.
 *
 * The agent's `src/mcp/results.ts` parses each MCP text content item; if it parses as JSON
 * with `$rita_kind`, it dispatches as artifact / citation / sqlite_table. Otherwise the text
 * is injected into the model's context as plain text.
 *
 * Each helper returns a single MCP `{ type: "text", text: <json> }` content item.
 */

import { z } from "zod";

export interface ContentItem {
  type: "text";
  text: string;
}

export function textItem(content: string): ContentItem {
  return { type: "text", text: content };
}

export function artifactItem(artifact: Record<string, unknown>): ContentItem {
  return {
    type: "text",
    text: JSON.stringify({ $rita_kind: "artifact", artifact }),
  };
}

export function webCitationItem(args: { url: string; title: string; id?: string }): ContentItem {
  return {
    type: "text",
    text: JSON.stringify({
      $rita_kind: "citation",
      citation: {
        type: "web",
        url: args.url,
        title: args.title,
        ...(args.id ? { id: args.id } : {}),
      },
    }),
  };
}

export function documentCitationItem(args: {
  uri: string;
  title: string;
  page?: number;
  id?: string;
}): ContentItem {
  return {
    type: "text",
    text: JSON.stringify({
      $rita_kind: "citation",
      citation: {
        type: "document",
        uri: args.uri,
        title: args.title,
        ...(args.page != null ? { page: args.page } : {}),
        ...(args.id ? { id: args.id } : {}),
      },
    }),
  };
}

export function sqliteTableItem(name: string, rows: Record<string, unknown>[]): ContentItem {
  return {
    type: "text",
    text: JSON.stringify({ $rita_kind: "sqlite_table", name, rows }),
  };
}

export function errorItem(args: {
  code: string;
  message: string;
  retryable?: boolean;
}): ContentItem {
  return {
    type: "text",
    text: JSON.stringify({
      $rita_kind: "error",
      error: {
        code: args.code,
        message: args.message,
        retryable: args.retryable ?? false,
      },
    }),
  };
}

export function modelContextItem(summary: string): ContentItem {
  return {
    type: "text",
    text: JSON.stringify({ $rita_kind: "model_context", summary }),
  };
}

/**
 * Per-conversation Daytona sandbox identity. Emitted by `execute_code` after a
 * successful `prepareCompute` so the agent can detect sandbox recreation
 * (auto-stop → fresh sandbox) and invalidate its `tablesShipped` set.
 * The agent dispatches this kind silently — no model-facing text.
 *
 * min(1): an empty sandbox_id would pass emission here but be dropped by the
 * agent-side parser (src/mcp/results.ts mirrors this schema), silently forcing
 * a conservative tablesShipped.clear() on every call. Reject it at the source.
 */
export const sandboxMetaPayloadSchema = z.object({ sandbox_id: z.string().min(1) });
export type SandboxMetaPayload = z.infer<typeof sandboxMetaPayloadSchema>;

export function sandboxMetaItem(sandboxId: string): ContentItem {
  return {
    type: "text",
    text: JSON.stringify({ $rita_kind: "sandbox_meta", sandbox_id: sandboxId }),
  };
}

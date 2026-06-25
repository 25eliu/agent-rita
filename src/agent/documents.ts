/**
 * Agent-side document handling.
 *
 * Documents arrive on each POST as `request.documents[]` (base64 inline or
 * URL reference). This module:
 *  1. Decodes / fetches them once per request.
 *  2. Stages them as `PendingDocument[]` keyed by id.
 *  3. Provides the delta (not-yet-shipped ids) the loop ships to the
 *     `query_documents` MCP tool via the `x-agentrita-documents` decoration.
 *
 * The agent NEVER parses doc content. PDF/DOCX/text extraction lives in
 * `mcp-server/src/tools/backend/documents/extract.ts` so the agent stays
 * thin (stateless, heavy capabilities → MCP). The agent only
 * carries raw bytes + metadata as a transit buffer.
 */

import type { UploadedDocument } from "../protocol/types";
import { getLogger } from "../lib/logger";

const logger = getLogger(["app", "agent", "documents"]);

const URL_FETCH_TIMEOUT_MS = 30_000;
/** Per-doc cap. PDFs around 20 MB are common; oversize gets rejected loud. */
export const MAX_DOC_BYTES = 25 * 1024 * 1024;

export interface PendingDocument {
  id: string;
  name: string;
  format: UploadedDocument["format"];
  /** Raw bytes ready to ship. Always populated by the time we read it. */
  bytes: Uint8Array;
}

/**
 * Decode / fetch each uploaded document into raw bytes. Skips failures
 * loudly so the request isn't blocked by a single bad URL — the model
 * just won't see that doc in `query_documents` results.
 */
export async function loadUploadedDocuments(
  documents: UploadedDocument[] | undefined,
): Promise<Map<string, PendingDocument>> {
  const out = new Map<string, PendingDocument>();
  if (!documents || documents.length === 0) return out;

  for (const doc of documents) {
    try {
      const bytes = await readBytes(doc);
      if (bytes.byteLength > MAX_DOC_BYTES) {
        logger.warn(`Document ${doc.id} exceeds ${MAX_DOC_BYTES} bytes — skipping`, {
          docId: doc.id,
          size: bytes.byteLength,
        });
        continue;
      }
      out.set(doc.id, {
        id: doc.id,
        name: doc.name,
        format: doc.format,
        bytes,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to load document ${doc.id}: ${msg}`, { docId: doc.id });
    }
  }
  logger.info(`Loaded ${out.size} of ${documents.length} documents`, {
    requested: documents.length,
    loaded: out.size,
  });
  return out;
}

async function readBytes(doc: UploadedDocument): Promise<Uint8Array> {
  if (doc.content_b64) {
    return Uint8Array.from(Buffer.from(doc.content_b64, "base64"));
  }
  if (doc.url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(doc.url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${doc.url}`);
      }
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Document ${doc.id} has neither content_b64 nor url`);
}

/**
 * Build the `x-agentrita-documents` payload shipped to the MCP server.
 * Returns `null` when there's nothing to send (no pending docs OR all
 * already shipped this chat).
 */
export function buildDocumentsDecoration(
  pending: Map<string, PendingDocument>,
  shippedIds: Set<string>,
): { id: string; name: string; format: UploadedDocument["format"]; content_b64: string }[] | null {
  const delta: { id: string; name: string; format: UploadedDocument["format"]; content_b64: string }[] = [];
  for (const doc of pending.values()) {
    if (shippedIds.has(doc.id)) continue;
    delta.push({
      id: doc.id,
      name: doc.name,
      format: doc.format,
      content_b64: Buffer.from(doc.bytes).toString("base64"),
    });
  }
  return delta.length > 0 ? delta : null;
}

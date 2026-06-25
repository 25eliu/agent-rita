/**
 * `list_documents` MCP tool — read-only inventory of what's loaded in the
 * conversation's doc store. The model can call this to decide whether to
 * search at all, or to filter `query_documents` by `doc_ids`.
 *
 * Like `query_documents`, accepts the conversation id + uploaded-docs
 * decoration so a fresh upload arriving on the same call gets ingested
 * before the listing is generated. That way the user can ask "what files
 * have I attached?" on the same turn the upload happened.
 */

import { z } from "zod";
import { textItem, type ContentItem } from "../../../lib/typed";
import { ensureHydrated, listDocuments } from "./store";
import { extractDocument } from "./extract";
import { chunkDocument } from "./chunk";
import { embedChunks } from "./retrieve";
import { upsertDocument, hasDocument } from "./store";
import { getLogger } from "../../../lib/logger";

const logger = getLogger(["mcp", "documents", "list"]);

export const listDocumentsSchema = {
  "x-agentrita-conversation-id": z
    .string()
    .optional()
    .describe("INTERNAL — populated by agent decoration. Do not set."),
  "x-agentrita-documents": z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        format: z.enum(["pdf", "docx", "txt", "md", "html"]),
        content_b64: z.string(),
      }),
    )
    .optional()
    .describe("INTERNAL — populated by agent decoration. Do not set."),
};

export const listDocumentsDescription =
  "List documents currently uploaded in this conversation. " +
  "Returns each document's id, name, format, and chunk count. " +
  "Use this when the user asks what files are attached, or to pick `doc_ids` for a targeted `query_documents` call.";

export async function listDocumentsHandler(args: {
  "x-agentrita-conversation-id"?: string;
  "x-agentrita-documents"?: Array<{
    id: string;
    name: string;
    format: "pdf" | "docx" | "txt" | "md" | "html";
    content_b64: string;
  }>;
}): Promise<{ content: ContentItem[] }> {
  const conversationId = args["x-agentrita-conversation-id"];
  if (!conversationId) {
    return {
      content: [
        textItem("Document listing requires a conversation id (X-Trace-Id)."),
      ],
    };
  }

  await ensureHydrated(conversationId);

  // Same-turn ingest path: if the user attached docs and the model called
  // list_documents first, do the ingest now so the listing reflects them.
  const newDocs = args["x-agentrita-documents"] ?? [];
  for (const d of newDocs) {
    if (hasDocument(conversationId, d.id)) continue;
    try {
      const bytes = Uint8Array.from(Buffer.from(d.content_b64, "base64"));
      const extracted = await extractDocument(d.format, bytes);
      const chunks = chunkDocument(d.id, extracted.pages);
      const embeddings = await embedChunks(chunks);
      await upsertDocument(conversationId, {
        id: d.id,
        name: d.name,
        format: d.format,
        chunks,
        embeddings,
        ingestedAt: Date.now(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Same-turn ingest failed for ${d.id}: ${msg}`);
    }
  }

  const docs = listDocuments(conversationId);
  if (docs.length === 0) {
    return {
      content: [
        textItem("No documents are currently loaded in this conversation."),
      ],
    };
  }
  const lines = [
    `${docs.length} document${docs.length === 1 ? "" : "s"} loaded:`,
    ...docs.map(
      (d) =>
        `- "${d.name}" (id=${d.id}, format=${d.format}, ${d.chunks.length} chunk${d.chunks.length === 1 ? "" : "s"})`,
    ),
  ];
  logger.info("Listed documents", { conversationId, count: docs.length });
  return { content: [textItem(lines.join("\n"))] };
}

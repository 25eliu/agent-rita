/**
 * Embedding + similarity retrieval.
 *
 * Uses Vercel AI SDK's `embedMany` for batch ingest and `embed` for the
 * query, with `cosineSimilarity` for ranking. Default model is OpenAI
 * `text-embedding-3-small` (1536 dim, $0.02 per 1M tokens). Override via
 * `RITA_EMBED_MODEL` env var.
 *
 * Retrieval contract:
 *  - Top-k after filtering by `docIds` (when provided).
 *  - Score is raw cosine [0,1] — no normalization or thresholding here.
 *    Callers (or eval graders) decide thresholds.
 */

import { embed, embedMany, cosineSimilarity, type EmbeddingModel } from "ai";
import { openai } from "@ai-sdk/openai";
import type { DocChunk } from "./chunk";
import { iterChunks, type StoredDocument } from "./store";
import { getLogger } from "../../../lib/logger";

const logger = getLogger(["mcp", "documents", "retrieve"]);

let _embedModel: EmbeddingModel | null = null;

export function getEmbeddingModel(): EmbeddingModel {
  if (_embedModel) return _embedModel;
  const modelId = process.env.RITA_EMBED_MODEL ?? "text-embedding-3-small";
  _embedModel = openai.textEmbeddingModel(modelId);
  return _embedModel;
}

/** Test-only — reset memoized embedding model. */
export function _resetEmbeddingModel(): void {
  _embedModel = null;
}

/** Test-only — inject a fake embedding model so tests don't hit the network. */
export function _setEmbeddingModelForTest(model: EmbeddingModel): void {
  _embedModel = model;
}

/**
 * Embed every chunk in a freshly-extracted doc. Returns a vector array
 * aligned 1:1 with the input chunks.
 */
export async function embedChunks(chunks: DocChunk[]): Promise<number[][]> {
  if (chunks.length === 0) return [];
  const model = getEmbeddingModel();
  const startedAt = Date.now();
  const { embeddings } = await embedMany({
    model,
    values: chunks.map((c) => c.text),
  });
  logger.info("Embedded chunks", {
    count: chunks.length,
    ms: Date.now() - startedAt,
    dim: embeddings[0]?.length ?? 0,
  });
  return embeddings;
}

export interface RetrievedChunk {
  chunk: DocChunk;
  doc: StoredDocument;
  score: number;
}

export async function retrieve(
  conversationId: string,
  query: string,
  options: { topK: number; docIds?: string[] },
): Promise<RetrievedChunk[]> {
  const model = getEmbeddingModel();
  const startedAt = Date.now();
  const { embedding: queryVec } = await embed({ model, value: query });
  const idFilter = options.docIds && options.docIds.length > 0
    ? new Set(options.docIds)
    : null;

  const scored: RetrievedChunk[] = [];
  for (const { chunk, doc, embedding } of iterChunks(conversationId)) {
    if (idFilter && !idFilter.has(doc.id)) continue;
    const score = cosineSimilarity(queryVec, embedding);
    scored.push({ chunk, doc, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, options.topK);
  logger.info("Retrieved", {
    conversationId,
    query: query.slice(0, 80),
    candidates: scored.length,
    returned: top.length,
    topScore: top[0]?.score ?? null,
    ms: Date.now() - startedAt,
  });
  return top;
}

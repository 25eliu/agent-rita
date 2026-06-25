/**
 * Token-aware chunking with sentence-boundary preference.
 *
 * Strategy:
 *  - Target ~500 tokens per chunk, ~50 token overlap, hard cap 800.
 *  - Walk sentence-by-sentence; emit a chunk when token budget would
 *    overflow. Sentence detection is cheap regex on `[.!?]\s+` boundaries.
 *  - Page metadata flows through unchanged so each chunk attributes back
 *    to the correct page when the source format had pages.
 *
 * Token counting uses `gpt-tokenizer` with the `cl100k_base` encoding —
 * matches OpenAI's `text-embedding-3-*` family. We don't ship the chunked
 * text through the embedding API limit; we only use the count to decide
 * boundaries.
 */

import { encode } from "gpt-tokenizer";
import type { ExtractedPage } from "./extract";

export interface DocChunk {
  /** Stable id within the doc — `"<docId>:<chunkIdx>"`. */
  id: string;
  /** Source doc id. */
  docId: string;
  /** Index within the doc, 0-based. */
  index: number;
  /** Page (when source was paginated). */
  page?: number;
  text: string;
  /** Token count for the chunk text — caller can cap retrieval token budget. */
  tokens: number;
}

export interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
  maxTokens?: number;
}

const DEFAULT_TARGET = 500;
const DEFAULT_OVERLAP = 50;
const DEFAULT_MAX = 800;

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z0-9])|\n{2,}/;

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tokensOf(text: string): number {
  return encode(text).length;
}

/**
 * Split a single page's text into chunks. Returns `[]` for empty input.
 */
function chunkOnePage(
  pageText: string,
  page: number | undefined,
  docId: string,
  startIndex: number,
  opts: Required<ChunkOptions>,
): DocChunk[] {
  if (!pageText.trim()) return [];
  const sentences = splitSentences(pageText);
  if (sentences.length === 0) return [];

  const chunks: DocChunk[] = [];
  let buf: string[] = [];
  let bufTokens = 0;
  let chunkIdx = startIndex;

  const flush = (): void => {
    if (buf.length === 0) return;
    const text = buf.join(" ").trim();
    if (!text) {
      buf = [];
      bufTokens = 0;
      return;
    }
    chunks.push({
      id: `${docId}:${chunkIdx}`,
      docId,
      index: chunkIdx,
      ...(page != null ? { page } : {}),
      text,
      tokens: tokensOf(text),
    });
    chunkIdx++;
    // Carry tail of last chunk into the next as overlap context.
    if (opts.overlapTokens > 0 && buf.length > 1) {
      const tail: string[] = [];
      let tailTokens = 0;
      for (let i = buf.length - 1; i >= 0; i--) {
        const sTokens = tokensOf(buf[i]);
        if (tailTokens + sTokens > opts.overlapTokens) break;
        tail.unshift(buf[i]);
        tailTokens += sTokens;
      }
      buf = tail;
      bufTokens = tailTokens;
    } else {
      buf = [];
      bufTokens = 0;
    }
  };

  for (const sentence of sentences) {
    const sTokens = tokensOf(sentence);
    // Single sentence longer than max — emit alone, oversize. Better to
    // surface verbatim than to drop. Caller can downweight on retrieval.
    if (sTokens > opts.maxTokens) {
      flush();
      chunks.push({
        id: `${docId}:${chunkIdx}`,
        docId,
        index: chunkIdx,
        ...(page != null ? { page } : {}),
        text: sentence,
        tokens: sTokens,
      });
      chunkIdx++;
      continue;
    }
    if (bufTokens + sTokens > opts.targetTokens && buf.length > 0) {
      flush();
    }
    buf.push(sentence);
    bufTokens += sTokens;
    if (bufTokens >= opts.maxTokens) flush();
  }
  flush();
  return chunks;
}

export function chunkDocument(
  docId: string,
  pages: ExtractedPage[],
  options?: ChunkOptions,
): DocChunk[] {
  const opts: Required<ChunkOptions> = {
    targetTokens: options?.targetTokens ?? DEFAULT_TARGET,
    overlapTokens: options?.overlapTokens ?? DEFAULT_OVERLAP,
    maxTokens: options?.maxTokens ?? DEFAULT_MAX,
  };
  const all: DocChunk[] = [];
  for (const p of pages) {
    const pageChunks = chunkOnePage(p.text, p.page, docId, all.length, opts);
    all.push(...pageChunks);
  }
  return all;
}

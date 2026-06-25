/**
 * Text extraction for uploaded documents.
 *
 * - PDF: `unpdf` (modern, no native deps; built on pdfjs). Extracts per-page
 *   so the chunking pass can attach `page` metadata to each chunk.
 * - DOCX: `mammoth.extractRawText` — strips formatting, returns plain text.
 *   No page concept in DOCX so `page` is undefined for chunks from DOCX.
 * - TXT / MD: utf-8 decode.
 *
 * Output is normalized as `ExtractedPage[]` even for single-page formats so
 * the chunker has a uniform interface.
 */

import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import * as cheerio from "cheerio";
import type { UploadedDocumentFormat } from "../../../../../src/protocol/types";
import { getLogger } from "../../../lib/logger";

const logger = getLogger(["mcp", "documents", "extract"]);

export interface ExtractedPage {
  /** 1-indexed; undefined for non-paginated formats. */
  page?: number;
  text: string;
}

export interface ExtractResult {
  pages: ExtractedPage[];
  /** Total characters across all pages — used for telemetry / size guards. */
  totalChars: number;
}

export async function extractDocument(
  format: UploadedDocumentFormat,
  bytes: Uint8Array,
): Promise<ExtractResult> {
  switch (format) {
    case "pdf":
      return extractPdf(bytes);
    case "docx":
      return extractDocx(bytes);
    case "html":
      return extractHtml(bytes);
    case "txt":
    case "md":
      return extractText_(bytes);
    default: {
      const exhaustive: never = format;
      throw new Error(`Unsupported document format: ${exhaustive as string}`);
    }
  }
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractResult> {
  // unpdf accepts Uint8Array directly. `mergePages: false` returns one
  // string per page, which we want for page-level chunk metadata.
  const pdf = await getDocumentProxy(bytes);
  const result = await extractText(pdf, { mergePages: false });
  const pageTexts = Array.isArray(result.text) ? result.text : [result.text];
  const pages: ExtractedPage[] = pageTexts.map((text, idx) => ({
    page: idx + 1,
    text: text ?? "",
  }));
  const totalChars = pages.reduce((acc, p) => acc + p.text.length, 0);
  logger.debug("PDF extracted", { pages: pages.length, totalChars });
  return { pages, totalChars };
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractResult> {
  const buf = Buffer.from(bytes);
  const result = await mammoth.extractRawText({ buffer: buf });
  const text = result.value;
  logger.debug("DOCX extracted", { totalChars: text.length });
  return { pages: [{ text }], totalChars: text.length };
}

function extractHtml(bytes: Uint8Array): ExtractResult {
  const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const text =
    $("body").text().trim() || $.root().text().trim();
  logger.debug("HTML extracted", { totalChars: text.length });
  return { pages: [{ text }], totalChars: text.length };
}

function extractText_(bytes: Uint8Array): ExtractResult {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return { pages: [{ text }], totalChars: text.length };
}

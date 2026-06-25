#!/usr/bin/env bun
/**
 * Manual smoke test for the document-RAG MCP handler.
 *
 * Hits `queryDocumentsHandler` directly (no agent loop, no HTTP).
 * Validates: format detection → text extraction → chunking → embedding →
 * retrieval → formatted result.
 *
 * Prereqs:
 *   - OPENAI_API_KEY set (used by the embedding model)
 *
 * Usage:
 *   bun scripts/smoke-doc-rag.ts <doc-path> "<question>" [doc-path-2] ...
 *
 * Examples:
 *   bun scripts/smoke-doc-rag.ts ./README.md "what is rita-tools?"
 *   bun scripts/smoke-doc-rag.ts ./report.pdf "what was the Q3 revenue?"
 *   bun scripts/smoke-doc-rag.ts ./notes.txt ./spec.md "summarize both"
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { queryDocumentsHandler } from "../mcp-server/src/tools/backend/documents/query-documents";

const FORMAT_MAP: Record<string, "pdf" | "docx" | "txt" | "md"> = {
  pdf: "pdf",
  docx: "docx",
  txt: "txt",
  md: "md",
  markdown: "md",
};

interface ParsedArgs {
  paths: string[];
  question: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: bun scripts/smoke-doc-rag.ts <doc-path> [more-paths...] \"<question>\"");
    process.exit(2);
  }
  const question = args[args.length - 1];
  const paths = args.slice(0, -1);
  if (paths.length === 0 || !question) {
    console.error("Need at least one doc path and a question.");
    process.exit(2);
  }
  return { paths, question };
}

interface DocPayload {
  id: string;
  name: string;
  format: "pdf" | "docx" | "txt" | "md";
  content_b64: string;
}

function loadDoc(path: string): DocPayload {
  const ext = extname(path).slice(1).toLowerCase();
  const format = FORMAT_MAP[ext];
  if (!format) {
    console.error(`Unsupported extension ".${ext}" in ${path}. Supported: pdf, docx, txt, md.`);
    process.exit(2);
  }
  const bytes = readFileSync(path);
  const name = basename(path);
  return {
    id: `smoke-${name}`,
    name,
    format,
    content_b64: bytes.toString("base64"),
  };
}

function formatItem(text: string): string {
  try {
    const parsed = JSON.parse(text) as { $rita_kind?: string } & Record<string, unknown>;
    if (parsed.$rita_kind === "citation") {
      const c = parsed.citation as { title: string; page?: number; uri?: string };
      const pageRef = c.page != null ? ` p.${c.page}` : "";
      return `[citation] ${c.title}${pageRef}  (${c.uri ?? ""})`;
    }
    if (parsed.$rita_kind === "error") {
      const e = parsed.error as { code: string; message: string };
      return `[error] ${e.code} — ${e.message}`;
    }
    return text;
  } catch {
    return text;
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set — embedding API will fail.");
    process.exit(2);
  }

  const { paths, question } = parseArgs(process.argv);
  const docs = paths.map(loadDoc);
  console.log(`Loading ${docs.length} document${docs.length === 1 ? "" : "s"}: ${docs.map((d) => d.name).join(", ")}`);
  console.log(`Question: ${question}\n`);

  const startedAt = Date.now();
  const result = await queryDocumentsHandler({
    query: question,
    top_k: 5,
    "x-agentrita-conversation-id": `smoke-${Date.now()}`,
    "x-agentrita-documents": docs,
  });
  const ms = Date.now() - startedAt;

  console.log(`--- query_documents result (${result.content.length} item${result.content.length === 1 ? "" : "s"}, ${ms}ms) ---\n`);
  for (let i = 0; i < result.content.length; i++) {
    console.log(`---- item ${i + 1} ----`);
    console.log(formatItem(result.content[i].text));
    console.log();
  }
}

main().catch((err) => {
  console.error("Smoke crashed:");
  console.error(err);
  process.exit(1);
});

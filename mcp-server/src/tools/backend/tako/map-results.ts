/**
 * Pure mappers from Tako MCP results into Rita typed content items.
 *
 * Loose validation on purpose: Tako's backend evolves its shape
 * independently, so every schema is .passthrough() with optional fields and
 * a failed parse degrades to plain-text passthrough (the model still gets a
 * usable answer; only citations/artifact/table extras are lost).
 */
import { z } from "zod";
import {
  textItem,
  webCitationItem,
  artifactItem,
  sqliteTableItem,
  type ContentItem,
} from "../../../lib/typed";

const cardSchema = z
  .object({
    title: z.string().nullable().optional(),
    webpage_url: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
    embed_url: z.string().nullable().optional(),
  })
  .passthrough();
type TakoCard = z.infer<typeof cardSchema>;

const webResultSchema = z
  .object({ title: z.string(), url: z.string() })
  .passthrough();

const searchStructuredSchema = z
  .object({
    cards: z.array(cardSchema).optional(),
    web_results: z.array(webResultSchema).optional(),
  })
  .passthrough();

const contentsStructuredSchema = z
  .object({
    records: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    data: z.string().nullable().optional(),
    total_rows: z.number().nullable().optional(),
    truncated: z.boolean().nullable().optional(),
  })
  .passthrough();

const MAX_ANSWER_CITATIONS = 10;
const ARTIFACT_ACK =
  "Top chart displayed in the workspace as an artifact. Do NOT re-describe the chart in detail; reference it and summarize the takeaway.";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the top-card artifact html. Contains BOTH the interactive iframe and
 * a static image + source link: if the Workspace sanitizer strips iframes
 * (it strips foreignObject from mermaid SVGs, so this is plausible), the
 * image still renders. This satisfies the spec's sanitizer decision rule
 * without a runtime probe.
 */
function topCardHtml(card: TakoCard): string | null {
  if (!card.embed_url && !card.image_url) return null;
  const title = escapeHtml(card.title ?? "Tako chart");
  const parts: string[] = [];
  if (card.embed_url) {
    parts.push(
      `<iframe src="${escapeHtml(card.embed_url)}" title="${title}" loading="lazy" style="width:100%;height:420px;border:0"></iframe>`,
    );
  }
  if (card.image_url) {
    parts.push(
      `<img src="${escapeHtml(card.image_url)}" alt="${title}" style="max-width:100%;height:auto">`,
    );
  }
  if (card.webpage_url) {
    parts.push(`<p><a href="${escapeHtml(card.webpage_url)}">View source on Tako</a></p>`);
  }
  return `<div style="font-family:system-ui,sans-serif">${parts.join("\n")}</div>`;
}

function citationItems(pairs: { url: string; title: string }[]): ContentItem[] {
  const seen = new Set<string>();
  const items: ContentItem[] = [];
  for (const p of pairs) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    items.push(webCitationItem({ url: p.url, title: p.title }));
  }
  return items;
}

export function mapSearchResult(text: string, structured: unknown): ContentItem[] {
  const parsed = searchStructuredSchema.safeParse(structured);
  if (!parsed.success || structured == null) return [textItem(text)];

  const cards = parsed.data.cards ?? [];
  const webResults = parsed.data.web_results ?? [];

  const pairs: { url: string; title: string }[] = [];
  for (const c of cards) {
    if (c.webpage_url) pairs.push({ url: c.webpage_url, title: c.title ?? "Tako chart" });
  }
  for (const w of webResults) {
    pairs.push({ url: w.url, title: w.title });
  }

  const items: ContentItem[] = [];
  const topCard = cards[0];
  const html = topCard ? topCardHtml(topCard) : null;
  if (html && topCard) {
    items.push(
      artifactItem({
        type: "html",
        uuid: crypto.randomUUID(),
        name: topCard.title ?? "Tako chart",
        description: `Tako chart: ${topCard.title ?? "search result"}`,
        content: html,
      }),
    );
  }
  items.push(textItem(html ? `${text}\n\n${ARTIFACT_ACK}` : text));
  items.push(...citationItems(pairs));
  return items;
}

const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

export function mapAnswerResult(text: string): ContentItem[] {
  const pairs: { url: string; title: string }[] = [];
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    const title = m[1];
    const url = m[2];
    if (title && url) pairs.push({ url, title });
  }
  return [textItem(text), ...citationItems(pairs).slice(0, MAX_ANSWER_CITATIONS)];
}

export function mapContentsResult(
  text: string,
  structured: unknown,
  tableName: string,
): ContentItem[] {
  const parsed = contentsStructuredSchema.safeParse(structured);
  if (!parsed.success || structured == null) return [textItem(text)];

  const records = parsed.data.records ?? [];
  if (records.length === 0) return [textItem(text)];

  const total = parsed.data.total_rows;
  const truncatedNote =
    parsed.data.truncated === true
      ? ` (truncated${typeof total === "number" ? ` from ${total} total rows; raise max_rows to fetch more` : ""})`
      : "";
  return [
    sqliteTableItem(tableName, records),
    textItem(
      `Loaded ${records.length} rows into SQL table "${tableName}"${truncatedNote}. Query it with execute_sql.`,
    ),
  ];
}

const TABLE_NAME_MAX = 40;

export function deriveTableName(url: string, override?: string): string {
  let base = override;
  if (!base) {
    try {
      const u = new URL(url);
      const lastSegment = u.pathname.split("/").filter(Boolean).at(-1) ?? "data";
      base = `tako_${u.hostname.split(".")[0]}_${lastSegment}`;
    } catch {
      base = "tako_data";
    }
  }
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, TABLE_NAME_MAX);
  if (slug.length === 0) return "tako_data";
  return /^[0-9]/.test(slug) ? `t_${slug}` : slug;
}

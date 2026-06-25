/**
 * Eager URL prefetch.
 *
 * Workspace extracts URLs from the user's message (linkify-it, cap 4) and
 * forwards them in `request.urls`. The loop fetches them server-side before
 * the first `generateText` call, converts HTML to markdown, and stitches the
 * results into a user message so the model can answer grounded in the page
 * content. Each prefetch also produces a web citation that flows through the
 * normal citation aggregator.
 *
 * Failures are logged and silently dropped — a single bad URL must not block
 * the entire request. `Promise.allSettled` + a per-URL timeout keeps the total
 * added latency bounded by the slowest URL (not the sum).
 */

import TurndownService from "turndown";
import { getLogger } from "../lib/logger";

const logger = getLogger(["app", "agent", "url-prefetch"]);

const TIMEOUT_MS = 10_000;
const MAX_CHARS = 20_000;
const MAX_URLS = 4;

export interface UrlPrefetchResult {
  url: string;
  title: string;
  markdown: string;
}

function makeTurndown(): TurndownService {
  const td = new TurndownService({ headingStyle: "atx" });
  td.remove(["script", "style", "nav", "footer", "header", "iframe"]);
  return td;
}

function extractTitle(html: string, url: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match?.[1]) {
    const decoded = match[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    if (decoded) return decoded;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function fetchOne(url: string): Promise<UrlPrefetchResult> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenBBAgent/1.0)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  const title = extractTitle(html, url);
  const markdown = makeTurndown().turndown(html).slice(0, MAX_CHARS);
  return { url, title, markdown };
}

export async function prefetchUrls(
  urls: string[] | undefined,
): Promise<UrlPrefetchResult[]> {
  if (!urls || urls.length === 0) return [];
  const sliced = urls.slice(0, MAX_URLS);
  const settled = await Promise.allSettled(sliced.map((u) => fetchOne(u)));
  const out: UrlPrefetchResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      out.push(r.value);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      logger.warn(`URL prefetch failed for ${sliced[i]}: ${msg}`);
    }
  }
  if (out.length > 0) {
    logger.info("URL prefetch done", { requested: sliced.length, ok: out.length });
  }
  return out;
}

/** Stable citation id derived from the URL, so re-fetching the same URL
 * dedupes through the existing citation aggregator. */
export async function urlCitationId(url: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`url:${url}`));
  const b = new Uint8Array(buf);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

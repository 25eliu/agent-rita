import { z } from "zod";
import TurndownService from "turndown";
import { textItem, webCitationItem, type ContentItem } from "../../lib/typed";

export const fetchWebpageSchema = {
  url: z.string().url().describe("The URL to fetch"),
};

interface FetchResult {
  markdown: string;
  title: string;
}

// A fresh TurndownService per call. .remove() mutates the instance, so
// sharing one across calls (or across tests) leaks state.
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

async function fetchAndConvert(url: string): Promise<FetchResult> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenBBAgent/1.0)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  const title = extractTitle(html, url);
  const markdown = makeTurndown().turndown(html).slice(0, 20_000);
  return { markdown, title };
}

export async function fetchWebpageHandler({
  url,
}: {
  url: string;
}): Promise<{ content: ContentItem[] }> {
  try {
    const { markdown, title } = await fetchAndConvert(url);
    return { content: [textItem(markdown), webCitationItem({ url, title })] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [textItem(`Failed to fetch ${url}: ${msg}`)] };
  }
}

export const fetchWebpageDescription =
  "Fetch a webpage and return its content as markdown. Use this when a URL is provided and you need to read its contents.";

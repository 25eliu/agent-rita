import { z } from "zod";
import { textItem, webCitationItem, type ContentItem } from "../../lib/typed";

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

interface TavilyResponse {
  results: TavilyResult[];
}

export const webSearchSchema = {
  query: z.string().describe("The search query to find information on the web"),
  max_results: z
    .number()
    .optional()
    .default(5)
    .describe("Maximum number of results to return (default: 5)"),
};

export async function webSearchHandler({
  query,
  max_results,
}: {
  query: string;
  max_results?: number;
}): Promise<{ content: ContentItem[] }> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return {
      content: [textItem("Web search is not configured (missing TAVILY_API_KEY).")],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: max_results ?? 5,
        search_depth: "basic",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      return { content: [textItem(`Search failed (${response.status}): ${text}`)] };
    }

    const data = (await response.json()) as TavilyResponse;
    const results = data.results ?? [];

    if (results.length === 0) {
      return { content: [textItem("No results found. Try a different query.")] };
    }

    const items: ContentItem[] = [];
    const summaries: string[] = [];
    for (const r of results) {
      summaries.push(`${r.title}\n${r.url}\n${r.content}`);
      items.push(webCitationItem({ url: r.url, title: r.title }));
    }
    items.unshift(textItem(summaries.join("\n\n---\n\n")));
    return { content: items };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { content: [textItem("Web search timed out. Try a simpler query.")] };
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export const webSearchDescription =
  "Search the web for current information. Use for recent events, news, live data not available in widgets, or factual lookups beyond your knowledge cutoff.";

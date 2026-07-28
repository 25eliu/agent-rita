import { z } from "zod";
import { textItem, type ContentItem } from "../../../lib/typed";
import { callTakoTool, withFreeTierHint } from "./client";
import { mapSearchResult } from "./map-results";

export const takoSearchSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language search query, one entity + one metric per call (e.g. "US GDP growth", "nvidia.com monthly visits"). Website traffic is keyed by domain, not brand name.',
    ),
  sources: z
    .array(z.enum(["data", "web"]))
    .min(1)
    .optional()
    .describe(
      'Sources to search. Omit for both (recommended). Narrow to ["data"] only after tako_available_data confirmed coverage; narrow to ["web"] only for news or qualitative content.',
    ),
};

export const takoSearchDescription =
  "Search Tako's live data graph and the web: company financials, macroeconomic indicators, website and app traffic, sports, plus general web results. The top result renders as a chart in the workspace, with sources cited. Prefer this over generic web search for quantitative, market, or economics questions. Zero results means the data is not covered; do not retry with rephrasings.";

export async function takoSearchHandler({
  query,
  sources,
}: {
  query: string;
  sources?: ("data" | "web")[];
}): Promise<{ content: ContentItem[] }> {
  try {
    const res = await callTakoTool("tako_search", {
      query,
      ...(sources ? { sources } : {}),
    });
    if (res.isError) return { content: [textItem(withFreeTierHint(res.text))] };
    return { content: mapSearchResult(res.text, res.structured) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        textItem(
          withFreeTierHint(
            `Tako search failed: ${msg}. Try again once; if it persists, answer from other tools.`,
          ),
        ),
      ],
    };
  }
}

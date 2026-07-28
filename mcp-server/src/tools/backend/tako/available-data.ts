import { z } from "zod";
import { textItem, type ContentItem } from "../../../lib/typed";
import { callTakoTool, withFreeTierHint } from "./client";

export const takoAvailableDataSchema = {
  q: z
    .string()
    .min(2)
    .describe(
      'The NAME of one entity or one metric (e.g. "Carnival", "unemployment rate") — not a full question. Split "Carnival passenger days" into q="Carnival" + coverage_filter="passenger days".',
    ),
  coverage_filter: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional case-insensitive word filter over the returned coverage names, for hunting one specific metric.",
    ),
};

export const takoAvailableDataDescription =
  "Check what data Tako actually has for one entity or metric — free and fast. Call this before tako_search when unsure coverage exists; it returns the exact metric names to search with, avoiding wasted searches.";

export async function takoAvailableDataHandler({
  q,
  coverage_filter,
}: {
  q: string;
  coverage_filter?: string;
}): Promise<{ content: ContentItem[] }> {
  try {
    const res = await callTakoTool("tako_available_data", {
      q,
      ...(coverage_filter ? { coverage_filter } : {}),
    });
    if (res.isError) return { content: [textItem(withFreeTierHint(res.text))] };
    return { content: [textItem(res.text)] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [textItem(withFreeTierHint(`Tako coverage lookup failed: ${msg}.`))],
    };
  }
}

import { z } from "zod";
import { textItem, type ContentItem } from "../../../lib/typed";
import { callTakoTool, withFreeTierHint } from "./client";
import { mapAnswerResult } from "./map-results";

export const takoAnswerSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'A specific data question to answer with grounded prose (e.g. "What was US GDP growth in 2024?"). For charts or multiple results use tako_search instead.',
    ),
};

export const takoAnswerDescription =
  "Ask Tako one specific data question and get a concise, citation-backed prose answer grounded in live financial, economic, and web data. Best for a single factual metric; use tako_search when a chart or several results would serve better.";

export async function takoAnswerHandler({
  query,
}: {
  query: string;
}): Promise<{ content: ContentItem[] }> {
  try {
    const res = await callTakoTool("tako_answer", { query });
    if (res.isError) return { content: [textItem(withFreeTierHint(res.text))] };
    return { content: mapAnswerResult(res.text) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        textItem(
          withFreeTierHint(
            `Tako answer failed: ${msg}. Try again once; if it persists, answer from other tools.`,
          ),
        ),
      ],
    };
  }
}

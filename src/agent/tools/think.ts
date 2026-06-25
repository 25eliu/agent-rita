/**
 * `_llm_think` — pure pass-through "thinking" tool. The model emits a plan
 * (string or bullet list); the tool yields a `planningStep` SSE and returns
 * the same text so the model can reference it in subsequent turns.
 *
 * No external LLM call, no state mutation, no side effects beyond appending
 * one planning event to the SSE artifact queue. The benefit is purely UX:
 * the workspace can render the plan inline, and the eval trace sees an
 * explicit chain-of-thought handle.
 */

import { tool } from "ai";
import { z } from "zod";
import { planningStep } from "../../protocol/events";
import type { SSEEvent } from "../../protocol/types";
import { getLogger } from "../../lib/logger";

const logger = getLogger(["app", "tools", "llm_think"]);

export const llmThinkSchema = z.object({
  plan: z
    .string()
    .min(1)
    .describe(
      "User-facing multi-line plan for what you are about to do — one bullet per step. " +
        "Describe actions in plain language; do not mention internal tool/function names, widget IDs, UUIDs, or dashboard IDs.",
    ),
  summary: z
    .string()
    .default("Planning")
    .describe(
      "One-sentence user-facing status line. Do not include the plan here; put the plan only in `plan`. " +
        "Do not mention internal tool/function names, widget IDs, UUIDs, or dashboard IDs.",
    ),
});

export const llmThinkDescription =
  "Surface a short plan before taking complex actions. " +
  "Use BEFORE multi-step workflows (search widgets → load → query → chart) so the user sees what you intend to do. " +
  "Use at most once per user request; do not call it again between routine follow-up searches, citations, or data retrieval steps. " +
  "Keep the wording user-facing: say things like getting widget data or running SQL, not raw tool/function names or IDs. " +
  "Returns the plan text back to you verbatim for reference in the next turn.";

export type LlmThinkArgs = z.infer<typeof llmThinkSchema>;

export interface LlmThinkContext {
  artifactQueue: SSEEvent[];
}

function summaryLine(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "Planning";
}

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const INTERNAL_ID_LABEL_PATTERN =
  /\b(?:widget_uuid|widget_id|dashboard_id|widget\s+id|dashboard\s+id|uuid)\s*[:=]?\s*["']?[\w.-]+["']?/gi;

function caseLike(match: string, replacement: string): string {
  return /^[A-Z]/.test(match) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
}

function replaceInternalToolPhrases(text: string): string {
  let out = text;
  const phraseReplacements: Array<[RegExp, string]> = [
    [/\b(?:call|use)\s+get_widget_data\b/gi, "get widget data"],
    [/\b(?:call|use)\s+execute_sql\b/gi, "run SQL"],
    [/\b(?:call|use)\s+peek_table\b/gi, "inspect the table"],
    [/\b(?:call|use)\s+peek_column_values\b/gi, "inspect column values"],
    [/\b(?:call|use)\s+search_widgets\b/gi, "search widgets"],
    [/\b(?:call|use)\s+get_widget_schema\b/gi, "check widget schema"],
    [/\b(?:call|use)\s+create_artifact\b/gi, "create the artifact"],
  ];
  for (const [pattern, replacement] of phraseReplacements) {
    out = out.replace(pattern, (match) => caseLike(match, replacement));
  }
  const standaloneReplacements: Array<[RegExp, string]> = [
    [/\bget_widget_data\b/gi, "getting widget data"],
    [/\bexecute_sql\b/gi, "SQL"],
    [/\bpeek_table\b/gi, "table preview"],
    [/\bpeek_column_values\b/gi, "column value inspection"],
    [/\bsearch_widgets\b/gi, "widget search"],
    [/\bget_widget_schema\b/gi, "widget schema check"],
    [/\bcreate_artifact\b/gi, "artifact creation"],
  ];
  for (const [pattern, replacement] of standaloneReplacements) {
    out = out.replace(pattern, (match) => caseLike(match, replacement));
  }
  return out;
}

function cleanDanglingText(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+([,.;:])/g, "$1")
        .replace(/\s*\(\s*\)/g, "")
        .replace(/\s*\[\s*]/g, "")
        .replace(/\s+\b(for|with|using|via|on)\s*([.;,])?$/i, "$2")
        .trimEnd()
    )
    .join("\n")
    .trim();
}

function userFacingPlanningText(value: string): string {
  const withoutIds = value
    .replace(/\s*[\[(]\s*(?:widget_uuid|widget_id|dashboard_id|widget\s+id|dashboard\s+id|uuid)\s*:\s*[^)\]]+[\])]/gi, "")
    .replace(INTERNAL_ID_LABEL_PATTERN, "")
    .replace(UUID_PATTERN, "");
  return cleanDanglingText(replaceInternalToolPhrases(withoutIds)) || "Planning";
}

export function runLlmThink(
  args: LlmThinkArgs,
  ctx: LlmThinkContext,
): string {
  ctx.artifactQueue.push(
    planningStep(userFacingPlanningText(summaryLine(args.summary)), "INFO", userFacingPlanningText(args.plan)),
  );
  logger.info("_llm_think emitted plan", {
    summary: args.summary,
    chars: args.plan.length,
  });
  return args.plan;
}

export function makeLlmThinkTool(ctx: LlmThinkContext) {
  return tool({
    description: llmThinkDescription,
    inputSchema: llmThinkSchema,
    execute: async (args) => runLlmThink(args as LlmThinkArgs, ctx),
  });
}

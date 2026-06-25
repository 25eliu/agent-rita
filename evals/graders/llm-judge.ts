/**
 * LLM-as-judge grader. Cheap model scores the agent's final answer
 * against a free-form criterion. Returns pass/fail based on a numeric
 * score >= threshold.
 *
 * Defaults to claude-haiku-4-5 if available via OpenRouter, falls back
 * to gpt-4.1-mini. Costs ~$0.0005 per case.
 */

import { generateText } from "ai";
import { resolveModel } from "../../src/lib/providers";
import type { Trace } from "../trace";
import type { GraderSpec } from "./index";

// Default judge: Gemini 3 Flash via OpenRouter — cheap, fast, good enough
// for binary scoring. Override with EVAL_JUDGE_MODEL env.
const JUDGE_MODEL =
  process.env.EVAL_JUDGE_MODEL ?? "openrouter:google/gemini-3-flash-preview";
const FALLBACK_JUDGE_MODEL = "openai:gpt-4o-mini";

export interface LlmJudgeArgs {
  criterion: string;
  threshold?: number;
}

function buildJudgePrompt(criterion: string, trace: Trace): string {
  const toolSummary = trace.toolCalls
    .map((c) => `${c.serverToolName ?? c.name}(${JSON.stringify(c.parameters).slice(0, 200)})`)
    .join("\n");
  const finalText = trace.finalText.slice(0, 4000);

  return [
    "You are scoring an AI agent run against a single criterion.",
    "Return ONLY a JSON object: { \"score\": <0..1>, \"reason\": \"<one sentence>\" }",
    "",
    `Criterion: ${criterion}`,
    "",
    "Tool calls (in order):",
    toolSummary || "(none)",
    "",
    "Final answer text:",
    finalText || "(no final answer)",
    "",
    "Score 0 (clearly fails) to 1 (clearly meets criterion). Be strict.",
  ].join("\n");
}

interface JudgeResult {
  score: number;
  reason: string;
}

function parseJudgeResponse(text: string): JudgeResult | null {
  const cleaned = text.replace(/^```json\n?/, "").replace(/\n?```$/, "");
  try {
    const parsed = JSON.parse(cleaned) as { score?: unknown; reason?: unknown };
    if (typeof parsed.score === "number" && typeof parsed.reason === "string") {
      return { score: parsed.score, reason: parsed.reason };
    }
  } catch {
    // fall through
  }
  return null;
}

async function callJudge(prompt: string): Promise<string> {
  for (const id of [JUDGE_MODEL, FALLBACK_JUDGE_MODEL]) {
    try {
      const model = resolveModel(id);
      const result = await generateText({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        maxOutputTokens: 200,
      });
      return result.text;
    } catch {
      // try next
    }
  }
  throw new Error("All judge models failed (set EVAL_JUDGE_MODEL or check API keys)");
}

export function llmJudge(args: LlmJudgeArgs): GraderSpec {
  const threshold = args.threshold ?? 0.7;
  return {
    name: `llmJudge(threshold=${threshold})`,
    grader: async (trace: Trace) => {
      const prompt = buildJudgePrompt(args.criterion, trace);
      try {
        const raw = await callJudge(prompt);
        const judged = parseJudgeResponse(raw);
        if (!judged) {
          return { pass: false, message: `Judge returned unparseable: ${raw.slice(0, 100)}` };
        }
        return judged.score >= threshold
          ? { pass: true, message: `score=${judged.score.toFixed(2)} ${judged.reason}` }
          : { pass: false, message: `score=${judged.score.toFixed(2)} (< ${threshold}) ${judged.reason}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { pass: false, message: `judge error: ${msg}` };
      }
    },
  };
}

#!/usr/bin/env bun
/**
 * Tier 3 eval runner.
 *
 * Loads cases from evals/cases/, runs each N times against a real LLM,
 * applies graders, and writes per-trial traces + a summary report.
 *
 * Usage:
 *   bun run evals                           # run all cases
 *   bun run evals -- --filter=widget        # filter case ids
 *   bun run evals -- --group=widget-selection
 *   EVAL_MODEL=openai:gpt-4.1-mini bun run evals
 *
 * Env:
 *   EVAL_MODEL        — model id passed to resolveModel (default openai:gpt-4.1-mini)
 *   EVAL_JUDGE_MODEL  — judge model for llmJudge graders
 *   EVAL_TRIALS       — overrides per-case trials
 *   EVAL_OUT_DIR      — output dir for trace JSONs (default evals/runs)
 *
 * The runner is idempotent: each run lands under evals/runs/<ISO-date>/.
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { resolveModel } from "../src/lib/providers";
import type {
  Widget,
  ChatMessage,
  ToolMessage,
  AgentTool,
  WorkspaceState,
  SkillCatalogEntry,
  SkillPayload,
  UploadedDocument,
} from "../src/protocol/types";
import type { LanguageModel } from "ai";
import { runEvalCase, type Trace } from "./trace";
import type { GraderSpec, GradeResult } from "./graders";
import { ALL_CASES, CASE_GROUPS } from "./cases";
import { renderReport, type CaseReport, type TrialReport } from "./report";

export interface EvalCase {
  id: string;
  description: string;
  messages: Array<ChatMessage | ToolMessage>;
  workspace?: { primary?: Widget[]; secondary?: Widget[]; extra?: Widget[] };
  workspaceState?: WorkspaceState | null;
  tools?: AgentTool[];
  generativeUiEnabled?: boolean;
  promptSuggestionsEnabled?: boolean;
  suggestionsVia?: "inline" | "tool";
  skillsCatalog?: SkillCatalogEntry[];
  selectedSkills?: SkillPayload[];
  urls?: string[];
  context?: unknown[];
  documents?: UploadedDocument[];
  timezone?: string;
  trials?: number;
  passRate?: number;
  graders: GraderSpec[];
}

interface RunSummary {
  totalCases: number;
  totalTrials: number;
  passedCases: number;
  failedCases: number;
  durationMs: number;
  modelId: string;
  date: string;
  cases: CaseReport[];
}

// Default to Gemini 3.1 Flash Lite via OpenRouter — cheapest capable model in the
// pricing table ($0.25/$1.5 per 1M). Override with EVAL_MODEL env.
const DEFAULT_MODEL = process.env.EVAL_MODEL ?? "openrouter:google/gemini-3.1-flash-lite";
const DEFAULT_TRIALS = process.env.EVAL_TRIALS ? Number(process.env.EVAL_TRIALS) : undefined;
const OUT_DIR = process.env.EVAL_OUT_DIR ?? "evals/runs";

function parseArgs(argv: string[]): { filter?: string; group?: string } {
  const out: { filter?: string; group?: string } = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--filter=")) out.filter = a.slice(9);
    else if (a.startsWith("--group=")) out.group = a.slice(8);
  }
  return out;
}

function selectCases(args: { filter?: string; group?: string }): EvalCase[] {
  let cases: EvalCase[] = ALL_CASES;
  if (args.group) {
    const group = CASE_GROUPS[args.group as keyof typeof CASE_GROUPS];
    if (!group) {
      console.error(`Unknown group: ${args.group}. Known: ${Object.keys(CASE_GROUPS).join(", ")}`);
      process.exit(2);
    }
    cases = [...group];
  }
  if (args.filter) {
    const f = args.filter.toLowerCase();
    cases = cases.filter((c) => c.id.toLowerCase().includes(f) || c.description.toLowerCase().includes(f));
  }
  return cases;
}

async function applyGraders(graders: GraderSpec[], trace: Trace): Promise<Array<GradeResult & { name: string }>> {
  const out: Array<GradeResult & { name: string }> = [];
  for (const spec of graders) {
    const result = await spec.grader(trace);
    out.push({ ...result, name: spec.name });
  }
  return out;
}

async function writeTrace(dateDir: string, trace: Trace, grades: Array<GradeResult & { name: string }>): Promise<void> {
  const caseDir = join(dateDir, trace.caseId);
  await mkdir(caseDir, { recursive: true });
  const path = join(caseDir, `trial-${trace.trial}.json`);
  await writeFile(
    path,
    JSON.stringify(
      {
        caseId: trace.caseId,
        trial: trace.trial,
        durationMs: trace.durationMs,
        toolCalls: trace.toolCalls,
        textChunks: trace.textChunks,
        finalText: trace.finalText,
        citations: trace.citations,
        events: trace.events,
        errored: trace.errored,
        errorMessage: trace.errorMessage,
        grades,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function runCase(
  ec: EvalCase,
  model: LanguageModel,
  modelId: string,
  dateDir: string,
): Promise<CaseReport> {
  const trials = DEFAULT_TRIALS ?? ec.trials ?? 3;
  const passRate = ec.passRate ?? 0.7;
  const trialReports: TrialReport[] = [];
  for (let i = 0; i < trials; i++) {
    const trace = await runEvalCase({
      caseId: ec.id,
      trial: i,
      model,
      messages: ec.messages,
      widgets: ec.workspace,
      workspaceState: ec.workspaceState ?? null,
      tools: ec.tools,
      generativeUiEnabled: ec.generativeUiEnabled,
      promptSuggestionsEnabled: ec.promptSuggestionsEnabled,
      suggestionsVia: ec.suggestionsVia,
      skillsCatalog: ec.skillsCatalog,
      selectedSkills: ec.selectedSkills,
      urls: ec.urls,
      context: ec.context,
      documents: ec.documents,
      timezone: ec.timezone,
      rawModelId: modelId,
    });
    const grades = await applyGraders(ec.graders, trace);
    await writeTrace(dateDir, trace, grades);
    const trialPass = grades.every((g) => g.pass);
    trialReports.push({
      trial: i,
      pass: trialPass,
      durationMs: trace.durationMs,
      grades,
      finalText: trace.finalText.slice(0, 200),
    });
  }
  const passed = trialReports.filter((t) => t.pass).length;
  const observedRate = passed / trials;
  return {
    id: ec.id,
    description: ec.description,
    trials,
    passed,
    requiredRate: passRate,
    observedRate,
    pass: observedRate >= passRate,
    trialReports,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const cases = selectCases(args);
  if (cases.length === 0) {
    console.error("No cases match filter/group.");
    process.exit(2);
  }

  const date = new Date().toISOString().replace(/[:.]/g, "-");
  const dateDir = join(OUT_DIR, date);
  await mkdir(dateDir, { recursive: true });

  console.log(`Eval run ${date}`);
  console.log(`Model:  ${DEFAULT_MODEL}`);
  console.log(`Cases:  ${cases.length}`);
  console.log(`Output: ${dateDir}\n`);

  const model = resolveModel(DEFAULT_MODEL);
  const startedAt = Date.now();
  const reports: CaseReport[] = [];
  let totalTrials = 0;
  for (const ec of cases) {
    process.stdout.write(`▶ ${ec.id} ... `);
    const report = await runCase(ec, model, DEFAULT_MODEL, dateDir);
    totalTrials += report.trials;
    reports.push(report);
    process.stdout.write(
      `${report.pass ? "✓" : "✗"} ${report.passed}/${report.trials} (req ${(report.requiredRate * 100).toFixed(0)}%)\n`,
    );
  }

  const summary: RunSummary = {
    totalCases: cases.length,
    totalTrials,
    passedCases: reports.filter((r) => r.pass).length,
    failedCases: reports.filter((r) => !r.pass).length,
    durationMs: Date.now() - startedAt,
    modelId: DEFAULT_MODEL,
    date,
    cases: reports,
  };

  await writeFile(join(dateDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");

  console.log(renderReport(summary));

  if (summary.failedCases > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Eval runner crashed:");
  console.error(err);
  process.exit(2);
});

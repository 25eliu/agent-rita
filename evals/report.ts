/**
 * Pretty-prints an eval run summary to stdout. Tools-style table; bold
 * pass/fail indicator; failed grader breakdown for diagnosis.
 */

import type { GradeResult } from "./graders";

export interface TrialReport {
  trial: number;
  pass: boolean;
  durationMs: number;
  grades: Array<GradeResult & { name: string }>;
  finalText: string;
}

export interface CaseReport {
  id: string;
  description: string;
  trials: number;
  passed: number;
  requiredRate: number;
  observedRate: number;
  pass: boolean;
  trialReports: TrialReport[];
}

export interface SummaryShape {
  totalCases: number;
  totalTrials: number;
  passedCases: number;
  failedCases: number;
  durationMs: number;
  modelId: string;
  date: string;
  cases: CaseReport[];
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function indent(text: string, by = "    "): string {
  return text.split("\n").map((l) => `${by}${l}`).join("\n");
}

export function renderReport(summary: SummaryShape): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(60));
  lines.push("Eval run summary");
  lines.push("=".repeat(60));
  lines.push(`Model:        ${summary.modelId}`);
  lines.push(`Date:         ${summary.date}`);
  lines.push(`Cases:        ${summary.totalCases}  (passed ${summary.passedCases}, failed ${summary.failedCases})`);
  lines.push(`Trials:       ${summary.totalTrials}`);
  lines.push(`Duration:     ${(summary.durationMs / 1000).toFixed(1)}s`);
  lines.push("");

  for (const c of summary.cases) {
    const status = c.pass ? "PASS" : "FAIL";
    lines.push(
      `[${status}] ${c.id} — ${c.passed}/${c.trials} (${pct(c.observedRate)} ≥ req ${pct(c.requiredRate)})`,
    );
    if (!c.pass) {
      // Show grader breakdown of the FIRST failing trial for quick triage.
      const firstFail = c.trialReports.find((t) => !t.pass);
      if (firstFail) {
        const failed = firstFail.grades.filter((g) => !g.pass);
        for (const g of failed) {
          lines.push(indent(`✗ ${g.name}: ${g.message}`));
        }
        if (firstFail.finalText) {
          lines.push(indent(`final: ${firstFail.finalText.slice(0, 120)}…`));
        }
      }
    }
  }
  lines.push("");
  lines.push(summary.failedCases === 0 ? "All cases passed." : `${summary.failedCases} case(s) failed.`);
  lines.push("");
  return lines.join("\n");
}

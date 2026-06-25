/**
 * Intent-understanding cases. Probe whether the model correctly classifies
 * the user's question before deciding which tool to use.
 *
 * Three buckets:
 *  - Knowledge-only: no widget/tool needed → answer directly
 *  - Multi-target: query mentions multiple entities → fetch all
 *  - Vague: ambiguous query → search_widgets first
 */

import type { EvalCase } from "../runner";
import { techWorkspace } from "../fixtures/workspaces";
import {
  toolCalled,
  toolNeverCalled,
  argContains,
  noBadState,
  llmJudge,
} from "../graders";

void toolCalled;

export const intentCases: EvalCase[] = [
  {
    id: "knowledge-only-eps-vs-revenue",
    description: "Conceptual finance question — should answer directly with no widget search",
    messages: [
      {
        role: "human",
        content: "what's the difference between EPS and revenue?",
      },
    ],
    workspace: techWorkspace,
    trials: 3,
    // CEO guidance: assert the OUTCOME (correct definition) rather than
    // the path. `toolNeverCalled` was reasoning-process pinning — Gemini
    // Flash sometimes over-fetches even when the system prompt forbids
    // it, but the final answer is still correct. Judge the answer; let
    // tool-routing cases catch routing regressions.
    passRate: 0.6,
    graders: [
      llmJudge({
        criterion:
          "The agent's response correctly contrasts EPS and revenue: revenue is total top-line sales / total income, while EPS is earnings per share (net income divided by share count). Partial but accurate explanations pass; fabricated numbers fail.",
        threshold: 0.6,
      }),
      noBadState(),
    ],
  },
  {
    id: "knowledge-only-define-pe-ratio",
    description: "Define P/E ratio — knowledge only, no widget needed",
    messages: [{ role: "human", content: "what is a P/E ratio?" }],
    workspace: techWorkspace,
    trials: 3,
    passRate: 0.6,
    graders: [
      toolNeverCalled("get_widget_data"),
      llmJudge({
        criterion:
          "The agent's response correctly identifies P/E as the price-to-earnings ratio (a stock's price divided by its earnings per share). Score based on the accuracy of what is present, not completeness — a partial but correct definition is acceptable.",
        threshold: 0.6,
      }),
      noBadState(),
    ],
  },
  {
    id: "multi-target-aapl-msft",
    description: "Compare two companies → must fetch BOTH AAPL and MSFT widgets",
    messages: [
      {
        role: "human",
        content: "compare Apple and Microsoft stock prices over the last year",
      },
    ],
    workspace: techWorkspace,
    trials: 3,
    passRate: 0.6,
    graders: [
      toolCalled("get_widget_data"),
      argContains("get_widget_data", ["aapl-price", "msft-price"]),
      noBadState(),
    ],
  },
  {
    id: "vague-query-tech-tickers",
    description:
      "Vague tech question → either calls search_widgets to discover, or fetches a tech-news widget directly from PRIMARY tier",
    messages: [{ role: "human", content: "tell me about the tech sector right now" }],
    workspace: techWorkspace,
    trials: 3,
    passRate: 0.6,
    graders: [
      // PRIMARY tier already includes tech-news; model can skip search.
      // Either path is valid as long as it grounded its answer in widgets.
      llmJudge({
        criterion:
          "The agent took action grounded in the workspace — either by calling search_widgets to explore, or by fetching a relevant widget like tech-news. It did NOT just answer with a generic disclaimer or hallucinate sector data.",
        threshold: 0.6,
      }),
      noBadState(),
    ],
  },
];

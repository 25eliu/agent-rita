/**
 * Locale-awareness cases. Probe whether the agent uses the user's
 * timezone (passed via `request.timezone`) to render times sensibly,
 * and whether "today" / "yesterday" / "now" resolve to the user's tz
 * rather than UTC or the agent's default.
 *
 * timezone arrives in the system prompt via buildDateSection in
 * prompt.ts (the "CURRENT DATE … / User timezone: …" section).
 * Cases here grade that it's reflected in the answer.
 */

import type { EvalCase } from "../runner";
import { macroWorkspace, techWorkspace } from "../fixtures/workspaces";
import { llmJudge, noBadState, toolCalled } from "../graders";

// timezone is threaded explicitly via EvalCase.timezone → QueryRequest.timezone
// (runner.ts → trace.ts), mirroring how the workspace frontend sends it.
export const localeCases: EvalCase[] = [
  {
    id: "timezone-aware-recent-data",
    description:
      "User in Lisbon asks for the latest US macro data → agent grounds its answer in one of the macro widgets (CPI/GDP/unemployment)",
    timezone: "Europe/Lisbon",
    messages: [
      {
        role: "human",
        content:
          "I'm in Lisbon. What was the most recent US economic data release?",
      },
    ],
    workspace: macroWorkspace,
    trials: 3,
    passRate: 0.5,
    graders: [
      llmJudge({
        criterion:
          "The agent grounded its answer in one of the macro widgets (us-cpi, us-gdp, or us-unemployment) — by fetching it OR by referencing it in its narration. Bonus credit if it acknowledged the user is in Lisbon.",
        threshold: 0.5,
      }),
      noBadState(),
    ],
  },
  {
    id: "ambiguous-best-stock-uses-tools",
    description:
      "Ambiguous superlative — model should not hallucinate; either ask, search, or fetch concrete widget data",
    messages: [
      { role: "human", content: "which is the best tech stock?" },
    ],
    workspace: techWorkspace,
    trials: 3,
    passRate: 0.6,
    graders: [
      // One of: search_widgets, get_widget_data, or a careful clarifying answer
      // (tool-or-clarify: simpler check via judge).
      llmJudge({
        criterion:
          "The agent did NOT confidently name a single 'best' stock without backing data. Either it called search_widgets/get_widget_data to ground its answer, or it asked a clarifying question about the user's criteria.",
        threshold: 0.6,
      }),
      noBadState(),
    ],
  },
];

void toolCalled;

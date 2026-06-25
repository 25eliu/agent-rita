/**
 * Native-tool selection cases.
 *
 * Verifies the model picks the right Phase-4 helper for each prompt shape:
 *   - Pasted unstructured text + "make a table" → create_table_from_text.
 *   - "Build an HTML report / dashboard" with structured rows already loaded
 *     → create_html_artifact (or create_artifact). We accept either to give
 *     the model latitude in picking the most appropriate artifact tool.
 *
 * No mock LLM here — uses the real eval model, single-shot.
 */

import type { EvalCase } from "../runner";
import type { ToolMessage } from "../../src/protocol/types";
import {
  noBadState,
  toolCalled,
} from "../graders";

const TICKERS_TABLE_LOADED: ToolMessage = {
  role: "tool",
  function: "execute_agent_tool",
  input_arguments: {
    tool_name: "load_table",
    server_id: "fixture",
    parameters: {},
  },
  data: [
    {
      items: [
        {
          text: JSON.stringify({
            $rita_kind: "sqlite_table",
            name: "tickers",
            rows: [
              { ticker: "AAPL", q4_revenue: 124.3 },
              { ticker: "MSFT", q4_revenue: 65.6 },
              { ticker: "GOOG", q4_revenue: 86.3 },
            ],
          }),
        },
      ],
    },
  ],
};

const PASTED_NUMBERS_BLOCK =
  "Q1 2024 revenue 3.6B, Q2 2024 revenue 4.1B, Q3 2024 revenue 4.9B, Q4 2024 revenue 5.1B.";

export const nativeToolsCases: EvalCase[] = [
  {
    id: "pasted-text-routes-to-table-from-text",
    description:
      "Free-text revenue figures pasted by the user — model should turn them into a table via create_table_from_text rather than answer prose.",
    messages: [
      {
        role: "human",
        content: `Take this and turn it into a table I can chart later: ${PASTED_NUMBERS_BLOCK}`,
      },
    ],
    workspace: { primary: [], secondary: [], extra: [] },
    trials: 3,
    passRate: 0.5,
    graders: [
      toolCalled("create_table_from_text"),
      noBadState(),
    ],
  },
  {
    id: "html-report-routes-to-html-or-artifact",
    description:
      "Loaded table + user asks for an inline HTML report — accept either create_html_artifact or create_artifact (table) so the model isn't punished for picking the right artifact tool.",
    messages: [
      {
        role: "human",
        content:
          "Build me a small HTML report card from the loaded tickers table — title, list of tickers with revenue, and a short summary line.",
      },
      TICKERS_TABLE_LOADED,
    ],
    workspace: { primary: [], secondary: [], extra: [] },
    trials: 3,
    passRate: 0.5,
    graders: [
      // Accept either tool — the goal is "produces an artifact", not the
      // exact one. `toolCalled` is OR-ed by case-level pass count if we
      // duplicate the case; here we accept by listing both with a permissive
      // grader: one of the two must fire.
      {
        name: 'toolCalled("create_html_artifact" OR "create_artifact")',
        grader: (trace) => {
          const ok = trace.toolCalls.some(
            (c) =>
              c.name === "create_html_artifact" ||
              c.name === "create_artifact",
          );
          return {
            pass: ok,
            message: ok
              ? "html or table artifact tool called"
              : `expected create_html_artifact or create_artifact; got [${trace.toolCalls.map((c) => c.name).join(", ")}]`,
          };
        },
      },
      noBadState(),
    ],
  },
];

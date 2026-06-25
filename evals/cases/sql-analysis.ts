/**
 * SQL analysis cases. Each starts from a workspace where the model already
 * has loaded widget data (simulated via prior tool message). The eval
 * asserts the model picks `execute_sql` (via execute_agent_tool) and the
 * SQL mentions the relevant identifiers.
 *
 * IMPORTANT: the prior tool message uses the typed-MCP `$rita_kind:
 * sqlite_table` payload (not raw widget-data JSON). This is the same
 * shape a real MCP tool would emit when shipping rows — `processMcpResult`
 * loads them into `pendingTables` and the model sees only a schema preview,
 * never the raw row JSON. Forces the SQL path: a model can't answer
 * `compare 1-month returns` from inline content because there is no inline
 * content. Mirrors how production data lands.
 */

import type { EvalCase } from "../runner";
import type { ToolMessage } from "../../src/protocol/types";
import { toolCalled, argContains, noBadState } from "../graders";

// Synthetic close values — deliberately unrelated to real-world AAPL /
// NVDA / MSFT prices so a model that hallucinates from training-data
// priors can't pass the case by coincidence. The only way to surface
// these specific numbers is to query `prices` via execute_sql.
const PRICES_LOADED: ToolMessage = {
  role: "tool",
  function: "execute_agent_tool",
  input_arguments: {
    tool_name: "load_prices",
    server_id: "fixture",
    parameters: {},
  },
  data: [
    {
      items: [
        {
          text: JSON.stringify({
            $rita_kind: "sqlite_table",
            name: "prices",
            rows: [
              { symbol: "AAPL", date: "2026-04-01", close: 7.13 },
              { symbol: "AAPL", date: "2026-05-01", close: 9.42 },
              { symbol: "NVDA", date: "2026-04-01", close: 11.55 },
              { symbol: "NVDA", date: "2026-05-01", close: 33.21 },
              { symbol: "MSFT", date: "2026-04-01", close: 19.07 },
              { symbol: "MSFT", date: "2026-05-01", close: 24.66 },
            ],
          }),
        },
      ],
    },
  ],
};

const SQL_TOOL = {
  name: "execute_sql",
  server_id: "rita",
  url: "http://localhost:8787/mcp",
  description: "Run SQLite SELECT/WITH against widget data already loaded.",
  input_schema: {
    properties: {
      sql: { type: "string" },
      "x-agentrita-tables": { type: "object" },
    },
    required: ["sql"],
  },
};

export const sqlAnalysisCases: EvalCase[] = [
  {
    id: "compare-three-stock-returns",
    description: "Compare 1-month return for NVDA, AAPL, MSFT after data load",
    messages: [
      { role: "human", content: "compare 1-month returns for NVDA, AAPL, MSFT" },
      PRICES_LOADED,
    ],
    // Empty workspace by design: the only data source is the pre-loaded
    // `prices` table from PRICES_LOADED. With no widgets in the workspace
    // get_widget_data is not registered (loop checks `hasWidgets`), so
    // the model has only one viable path — execute_sql against the
    // loaded table. Mirrors the user state "I already loaded data,
    // now compute against it" without giving the model a re-fetch escape.
    workspace: { primary: [], secondary: [], extra: [] },
    tools: [SQL_TOOL],
    trials: 3,
    passRate: 0.6,
    // Tool-call grader is the contract here — "did the model use SQL to
    // answer this". `argContains([NVDA, AAPL, MSFT])` over-constrained
    // because `GROUP BY symbol` is correct SQL and doesn't mention
    // tickers literally. CEO guidance: assert outcome, not query shape.
    graders: [
      toolCalled("execute_sql"),
      noBadState(),
    ],
  },
  {
    id: "max-close-by-symbol",
    description: "Highest closing price by symbol after data load",
    messages: [
      { role: "human", content: "what's the highest close for each ticker?" },
      PRICES_LOADED,
    ],
    // Empty workspace by design: the only data source is the pre-loaded
    // `prices` table from PRICES_LOADED. With no widgets in the workspace
    // get_widget_data is not registered (loop checks `hasWidgets`), so
    // the model has only one viable path — execute_sql against the
    // loaded table. Mirrors the user state "I already loaded data,
    // now compute against it" without giving the model a re-fetch escape.
    workspace: { primary: [], secondary: [], extra: [] },
    tools: [SQL_TOOL],
    trials: 3,
    passRate: 0.6,
    graders: [
      toolCalled("execute_sql"),
      argContains("execute_sql", ["max", "close"]),
      noBadState(),
    ],
  },
];

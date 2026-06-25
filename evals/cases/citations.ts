/**
 * Citations cases. Validates that intermediate citations registered on
 * a prior round-trip survive the next emit and the terminal collection.
 *
 * The single-shot eval runner cuts at the first round-trip emit, so each
 * case here either:
 *   (a) primes a citation via `extra_state.intermediate_citations` and
 *       expects the next emit to re-bake it, or
 *   (b) primes a citation via a typed MCP `$rita_kind: "citation"` payload
 *       and expects the terminal `citationCollection` SSE to carry it.
 */

import type { EvalCase } from "../runner";
import type { ToolMessage } from "../../src/protocol/types";
import { techWorkspace } from "../fixtures/workspaces";
import {
  intermediateCitationContains,
  noBadState,
} from "../graders";

const STASH_ID = "stashed-eval-citation";

const PRIOR_WITH_STASH: ToolMessage = {
  role: "tool",
  function: "execute_agent_tool",
  input_arguments: { tool_name: "fetch_webpage", server_id: "rita" },
  data: [
    {
      items: [
        {
          text: "External page already fetched — content not relevant; the citation is the contract.",
        },
      ],
    },
  ],
  extra_state: {
    intermediate_citations: [
      {
        id: STASH_ID,
        source_info: { type: "web", name: "Earlier source", citable: true },
        details: [{ link: "https://earlier.example", title: "Earlier source" }],
        signature: "",
      },
    ],
  },
};

const FETCH_TOOL = {
  name: "fetch_webpage",
  server_id: "rita",
  url: "http://localhost:8787/mcp",
  description: "Fetch a webpage. Returns body + citation.",
  input_schema: {
    properties: { url: { type: "string" } },
    required: ["url"],
  },
};

const SEARCH_TOOL = {
  name: "web_search",
  server_id: "rita",
  url: "http://localhost:8787/mcp",
  description: "Search the web. Returns links + citations.",
  input_schema: {
    properties: { q: { type: "string" } },
    required: ["q"],
  },
};

// Graders deliberately do NOT assert which tool the model picks next.
// Citation survival is a protocol contract — it must hold regardless of
// whether the model fetches another page, picks a widget, or answers
// directly. Tool-choice assertions belong in widget-selection / tool-routing.
export const citationsCases: EvalCase[] = [
  {
    id: "citation-survives-next-emit",
    description:
      "Stashed intermediate citation re-emitted in the next round-trip's extra_state, regardless of tool choice",
    messages: [
      { role: "human", content: "research more — find a follow-up source" },
      PRIOR_WITH_STASH,
    ],
    workspace: techWorkspace,
    tools: [FETCH_TOOL, SEARCH_TOOL],
    trials: 3,
    passRate: 0.66,
    graders: [
      intermediateCitationContains(STASH_ID),
      noBadState(),
    ],
  },
  {
    id: "citation-survives-widget-fetch-path",
    description:
      "Stashed citation re-emitted when prompt nudges the model toward a widget fetch",
    messages: [
      { role: "human", content: "now pull AAPL's price to compare" },
      PRIOR_WITH_STASH,
    ],
    workspace: techWorkspace,
    tools: [],
    trials: 3,
    passRate: 0.5,
    graders: [
      intermediateCitationContains(STASH_ID),
      noBadState(),
    ],
  },
  {
    id: "citation-survives-terminal-answer",
    description:
      "Stashed citation surfaces in terminal citationCollection when no further round-trip is needed",
    messages: [
      { role: "human", content: "summarize the source you already fetched" },
      PRIOR_WITH_STASH,
    ],
    workspace: techWorkspace,
    tools: [FETCH_TOOL],
    trials: 3,
    passRate: 0.5,
    graders: [
      intermediateCitationContains(STASH_ID),
      noBadState(),
    ],
  },
];

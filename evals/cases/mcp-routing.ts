/**
 * MCP-tool routing cases. Mirrors `tool-routing.ts` but covers tools that
 * live in the MCP server rather than the agent: fetch_webpage, web_search.
 * Single-shot — the eval cuts at the first `execute_agent_tool` SSE, so
 * graders inspect tool choice + args, not the (would-be) MCP response.
 */

import type { EvalCase } from "../runner";
import {
  argContains,
  noBadState,
  toolCalled,
  toolNeverCalled,
} from "../graders";

const FETCH_WEBPAGE_TOOL = {
  name: "fetch_webpage",
  server_id: "rita",
  url: "http://localhost:8787/mcp",
  description:
    "Fetch a webpage and return its content as markdown. Use this when a URL is provided and you need to read its contents.",
  input_schema: {
    properties: { url: { type: "string" } },
    required: ["url"],
  },
};

const WEB_SEARCH_TOOL = {
  name: "web_search",
  server_id: "rita",
  url: "http://localhost:8787/mcp",
  description:
    "Search the web for recent or general information. Returns links and snippets.",
  input_schema: {
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

export const mcpRoutingCases: EvalCase[] = [
  {
    id: "explicit-url-routes-to-fetch-webpage",
    description:
      "User pastes a specific URL — model should fetch it via fetch_webpage instead of web_search.",
    messages: [
      {
        role: "human",
        content:
          "Summarize what's at https://www.openbb.co/about — quote the headline and one bullet.",
      },
    ],
    workspace: { primary: [], secondary: [], extra: [] },
    tools: [FETCH_WEBPAGE_TOOL, WEB_SEARCH_TOOL],
    trials: 3,
    passRate: 0.5,
    graders: [
      toolCalled("fetch_webpage"),
      argContains("fetch_webpage", ["openbb"]),
      toolNeverCalled("web_search"),
      noBadState(),
    ],
  },
  {
    id: "open-question-routes-to-web-search",
    description:
      "User asks a general 'what is X' kind of question with no URL — model should web_search, not fetch_webpage.",
    messages: [
      {
        role: "human",
        content:
          "What are the top 3 reasons financial analysts use copilots in 2026? Cite sources.",
      },
    ],
    workspace: { primary: [], secondary: [], extra: [] },
    tools: [FETCH_WEBPAGE_TOOL, WEB_SEARCH_TOOL],
    trials: 3,
    passRate: 0.5,
    graders: [
      toolCalled("web_search"),
      toolNeverCalled("fetch_webpage"),
      noBadState(),
    ],
  },
];

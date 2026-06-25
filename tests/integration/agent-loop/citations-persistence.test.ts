/**
 * Tier 2 — citations persist across multi-step turns.
 *
 * Scenario this guards: the user asks something that triggers two MCP
 * round-trips back-to-back (e.g. fetch_webpage → execute_agent_tool with
 * a different tool). The first round-trip registers a citation; the
 * second re-POST must read it back from `extra_state.intermediate_citations`,
 * the loop must surface it on the next emit, and the terminal collection
 * must include it. If any link breaks the citation silently disappears.
 *
 * Mirrors the contract ada tests via `_handle_function_call_result_message`
 * + `intermediate_citations` plumbing, but stays in-process via mocked LLM.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop } from "../../../src/agent/loop";
import type {
  AgentTool,
  Citation,
  QueryRequest,
  SSEEvent,
  ToolMessage,
} from "../../../src/protocol/types";
import {
  llmCallsTool,
  llmEmitsText,
  makeSequencedMockLlm,
} from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";

beforeEach(() => clearAllModuleState());

const FIRST: Citation = {
  id: "first-cite",
  source_info: { type: "web", name: "First", citable: true },
  details: [{ link: "https://first.example", title: "First" }],
  signature: "",
};

function findFunctionCall(events: SSEEvent[], fn: string): SSEEvent | undefined {
  return events.find(
    (e) =>
      e.event === "copilotFunctionCall" &&
      (e.data as { function?: string }).function === fn,
  );
}

function tools(): AgentTool[] {
  return [
    {
      name: "fetch_webpage",
      server_id: "rita",
      url: "http://localhost:8787/mcp",
      description: "Fetch",
      input_schema: { properties: { url: { type: "string" } }, required: ["url"] },
    },
    {
      name: "web_search",
      server_id: "rita",
      url: "http://localhost:8787/mcp",
      description: "Search",
      input_schema: { properties: { q: { type: "string" } }, required: ["q"] },
    },
  ];
}

describe("citations persist across two MCP round-trips and a terminal turn", () => {
  it("step 2 re-POST carries citations from step 1; terminal collection surfaces them", async () => {
    // Step 1 already happened — its result is the prior tool message
    // injected into the request. The MCP result emits a typed citation
    // via the $rita_kind protocol (so `processMcpResult` registers it on
    // ctx.mcpCitations).
    const step1Result: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: { tool_name: "fetch_webpage", server_id: "rita" },
      data: [
        {
          items: [
            {
              text: JSON.stringify({
                $rita_kind: "citation",
                citation: {
                  type: "web",
                  url: "https://first.example",
                  title: "First",
                  id: "first-cite",
                },
              }),
            },
          ],
        },
      ],
    };

    // The model decides it needs another MCP call (web_search) before
    // answering. Then it emits text and stops.
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "research" },
            step1Result,
          ],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("web_search", { q: "follow up" }),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "persist-1",
      }),
    );

    const step2 = findFunctionCall(events, "execute_agent_tool");
    expect(step2).toBeDefined();
    const extra = (step2!.data as { extra_state?: { intermediate_citations?: Citation[] } })
      .extra_state;
    const carried = extra?.intermediate_citations ?? [];
    expect(carried.find((c) => c.id === "first-cite")).toBeDefined();
  });

  it("terminal turn re-emits citation registered via prior MCP result", async () => {
    const step1Result: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: { tool_name: "fetch_webpage", server_id: "rita" },
      data: [
        {
          items: [
            {
              text: JSON.stringify({
                $rita_kind: "citation",
                citation: {
                  type: "web",
                  url: "https://first.example",
                  title: "First",
                  id: "first-cite",
                },
              }),
            },
          ],
        },
      ],
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "summarize" },
            step1Result,
          ],
          tools: tools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([llmEmitsText("done")]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "persist-2",
      }),
    );
    const collection = events.find((e) => e.event === "copilotCitationCollection");
    expect(collection).toBeDefined();
    const list = (collection!.data as { citations: Citation[] }).citations;
    expect(list.find((c) => c.id === "first-cite")).toBeDefined();
  });

  it("regression: intermediate_citations from extra_state are restored even when MCP body is empty", async () => {
    // ada equivalent: stash-only re-POST with no actionable text. The
    // intermediate_citations slot is the only thing carrying the cite.
    const stashOnly: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: { tool_name: "fetch_webpage", server_id: "rita" },
      data: [{ items: [{ text: "" }] }],
      extra_state: { intermediate_citations: [FIRST] },
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "go on" },
            stashOnly,
          ],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([llmEmitsText("ok")]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "persist-3",
      }),
    );
    const collection = events.find((e) => e.event === "copilotCitationCollection");
    expect(collection).toBeDefined();
    const list = (collection!.data as { citations: Citation[] }).citations;
    expect(list.find((c) => c.id === "first-cite")).toBeDefined();
  });
});

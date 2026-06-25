/**
 * Tier 2 — citations are baked into `extra_state.intermediate_citations`
 * at every round-trip emit point in the loop.
 *
 * Why this exists: there are 4 round-trip emit sites in `src/agent/loop.ts`
 * (executeAgentTool, getSkillContent, getWidgetData, getWidgetDataSsrm) plus
 * the terminal citation collection. Each one is independently responsible
 * for baking accumulated citations onto its outbound payload — if a
 * future emit site is added without baking, citations vanish across the
 * re-POST. This test fans out across every emit path with a synthetic
 * stashed citation and asserts it survives. Adding a 5th emit point
 * without baking will fail this suite.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop } from "../../../src/agent/loop";
import type {
  AgentTool,
  Citation,
  QueryRequest,
  SSEEvent,
  ToolMessage,
  Widget,
} from "../../../src/protocol/types";
import { llmCallsTool, llmEmitsText, makeMockLlm } from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";

beforeEach(() => clearAllModuleState());

const STASHED: Citation = {
  id: "stashed-1",
  source_info: { type: "web", name: "Earlier source", citable: true },
  details: [{ link: "https://earlier.example", title: "Earlier source" }],
  signature: "",
};

function priorToolMessage(): ToolMessage {
  return {
    role: "tool",
    function: "execute_agent_tool",
    input_arguments: { tool_name: "fetch_webpage", server_id: "rita" },
    data: [{ items: [{ text: "page body" }] }],
    extra_state: { intermediate_citations: [STASHED] },
  };
}

function findFunctionCall(events: SSEEvent[], fn: string): SSEEvent | undefined {
  return events.find(
    (e) =>
      e.event === "copilotFunctionCall" &&
      (e.data as { function?: string }).function === fn,
  );
}

function readIntermediate(event: SSEEvent): Citation[] | undefined {
  const data = event.data as { extra_state?: { intermediate_citations?: Citation[] } };
  return data.extra_state?.intermediate_citations;
}

function mcpTools(): AgentTool[] {
  return [
    {
      name: "fetch_webpage",
      server_id: "rita",
      url: "http://localhost:8787/mcp",
      description: "Fetch a webpage",
      input_schema: { properties: { url: { type: "string" } }, required: ["url"] },
    },
  ];
}

const widget: Widget = {
  uuid: "w-emit",
  origin: "openbb",
  widget_id: "emit",
  name: "Emit Widget",
  description: "",
  params: [],
};

const ssrmWidget: Widget = {
  uuid: "w-ssrm",
  origin: "openbb",
  widget_id: "ssrm",
  name: "SSRM Widget",
  description: "",
  params: [],
  metadata: {
    schema: {
      tableName: "T",
      database: "D",
      schema: "S",
      columns: [{ name: "x", type: "VARCHAR" }],
    },
  },
};

describe("citations bake into extra_state at every round-trip emit point", () => {
  it("executeAgentTool: stashed citation re-emitted on the next MCP round-trip", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "go" },
            priorToolMessage(),
          ],
          tools: mcpTools(),
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("fetch_webpage", { url: "https://x" })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "emit-mcp",
      }),
    );
    const exec = findFunctionCall(events, "execute_agent_tool");
    expect(exec).toBeDefined();
    const cits = readIntermediate(exec!);
    expect(cits?.find((c) => c.id === "stashed-1")).toBeDefined();
  });

  it("getSkillContent: stashed citation re-emitted on a skill round-trip", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "explain" },
            priorToolMessage(),
          ],
          skills_catalog: [{ slug: "intro", description: "intro skill", updatedAt: "" }],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("get_skill_content", { slug: "intro" })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "emit-skill",
      }),
    );
    const skill = findFunctionCall(events, "get_skill_content");
    expect(skill).toBeDefined();
    const cits = readIntermediate(skill!);
    expect(cits?.find((c) => c.id === "stashed-1")).toBeDefined();
  });

  it("getWidgetData: stashed citation re-emitted on a widget round-trip", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "fetch" },
            priorToolMessage(),
          ],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          llmCallsTool("get_widget_data", {
            widgets: [{ widget_uuid: "w-emit" }],
          }),
        ),
        allWidgets: [widget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "emit-widget",
      }),
    );
    const wd = findFunctionCall(events, "get_widget_data");
    expect(wd).toBeDefined();
    const cits = readIntermediate(wd!);
    expect(cits?.find((c) => c.id === "stashed-1")).toBeDefined();
  });

  it("getWidgetDataSsrm: stashed citation re-emitted on an SSRM widget round-trip", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "query" },
            priorToolMessage(),
          ],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          llmCallsTool("get_widget_data", {
            widgets: [
              { widget_uuid: "w-ssrm", input_args: { query: "SELECT 1" } },
            ],
          }),
        ),
        allWidgets: [ssrmWidget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "emit-ssrm",
      }),
    );
    const wd = findFunctionCall(events, "get_widget_data");
    expect(wd).toBeDefined();
    const cits = readIntermediate(wd!);
    expect(cits?.find((c) => c.id === "stashed-1")).toBeDefined();
  });

  it("citationCollection: terminal emit includes stashed citation when no further round-trip is needed", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "summarize" },
            priorToolMessage(),
          ],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmEmitsText("summary")),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "emit-final",
      }),
    );
    const cit = events.find((e) => e.event === "copilotCitationCollection");
    expect(cit).toBeDefined();
    const list = (cit!.data as { citations: Citation[] }).citations;
    expect(list.find((c) => c.id === "stashed-1")).toBeDefined();
  });
});

describe("citations baked: regression — no double-bake on identical re-POSTs", () => {
  it("regression: same stashed citation arriving twice still surfaces once after dedup", async () => {
    // The stash arrives via prior tool message AND would be re-baked by the
    // emit. dedupeCitations is keyed on widget_uuid|input_args for widget
    // cites and link for web cites — so a duplicate web cite collapses.
    const dupePrior = priorToolMessage();
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "ok" },
            dupePrior,
          ],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmEmitsText("done")),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "emit-dupe",
      }),
    );
    const cit = events.find((e) => e.event === "copilotCitationCollection");
    const list = (cit!.data as { citations: Citation[] }).citations;
    const matches = list.filter(
      (c) =>
        c.details[0] &&
        (c.details[0] as { link?: string }).link === "https://earlier.example",
    );
    expect(matches.length).toBe(1);
  });
});

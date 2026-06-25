/**
 * Tier 2 — pre-call schema validation for `get_widget_data` and
 * `get_skill_content`.
 *
 * If the model emits an input that the Vercel AI SDK accepts but our
 * stricter schema rejects (or schemas drift), the loop must NOT crash
 * and must NOT emit a `copilotFunctionCall`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop } from "../../../src/agent/loop";
import type { QueryRequest, SSEEvent, ToolMessage, Widget } from "../../../src/protocol/types";
import {
  llmCallsTool,
  llmEmitsText,
  makeSequencedMockLlm,
} from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";

beforeEach(() => clearAllModuleState());

const widget: Widget = {
  uuid: "w-good",
  origin: "openbb",
  widget_id: "w",
  name: "Good Widget",
  description: "",
  params: [],
};

function findFunctionCall(events: SSEEvent[], fn: string): SSEEvent | undefined {
  return events.find(
    (e) =>
      e.event === "copilotFunctionCall" &&
      (e.data as { function?: string }).function === fn,
  );
}

function findWarn(events: SSEEvent[]): SSEEvent | undefined {
  return events.find(
    (e) =>
      e.event === "copilotStatusUpdate" &&
      (e.data as { eventType?: string }).eventType === "WARNING",
  );
}

describe("get_widget_data — malformed input is rejected without emit", () => {
  it("regression: missing `widgets` array → warning, no SSE", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "go" }] } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          // missing required `widgets` key
          llmCallsTool("get_widget_data", { foo: "bar" }),
          llmEmitsText("ok, asking again with widgets next time"),
        ]),
        allWidgets: [widget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "malformed-1",
      }),
    );
    expect(findFunctionCall(events, "get_widget_data")).toBeUndefined();
    expect(findWarn(events)).toBeDefined();
  });

  it("regression: `widgets[0].widget_uuid` not a string → warning, no SSE", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "go" }] } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("get_widget_data", { widgets: [{ widget_uuid: 12345 }] }),
          llmEmitsText("retry needed"),
        ]),
        allWidgets: [widget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "malformed-2",
      }),
    );
    expect(findFunctionCall(events, "get_widget_data")).toBeUndefined();
    expect(findWarn(events)).toBeDefined();
  });

  it("does not run a corrected follow-up call after malformed widget data input", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "go" }] } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("get_widget_data", { foo: "bar" }),
          llmCallsTool("get_widget_data", { widgets: [{ widget_uuid: "w-good" }] }),
        ]),
        allWidgets: [widget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "malformed-3",
      }),
    );
    expect(findFunctionCall(events, "get_widget_data")).toBeUndefined();
    expect(findWarn(events)).toBeDefined();
  });
});

describe("get_skill_content — malformed input is rejected without emit", () => {
  it("regression: missing `slug` → warning, no SSE", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "explain" }],
          skills_catalog: [{ slug: "intro", description: "intro skill", updatedAt: "" }],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("get_skill_content", { reason: "no slug supplied" }),
          llmEmitsText("ok"),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "skill-bad",
      }),
    );
    expect(findFunctionCall(events, "get_skill_content")).toBeUndefined();
    expect(findWarn(events)).toBeDefined();
  });

  it("round-trips even when the model asks for an already loaded skill", async () => {
    const loadedSkillTool: ToolMessage = {
      role: "tool",
      function: "get_skill_content",
      input_arguments: { slug: "summarize-table" },
      data: [
        {
          status: "success",
          data: {
            skill: {
              contentMarkdown: "Use concise table summaries.",
            },
          },
        },
      ] as unknown as ToolMessage["data"],
      extra_state: { loaded_skill_slugs: ["summarize-table"] },
    };

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "summarize the table" },
            loadedSkillTool,
          ],
          skills_catalog: [
            { slug: "summarize-table", description: "Use always when summarizing tables", updatedAt: "" },
          ],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("get_skill_content", {
            slug: "summarize-table",
            reason: "still looks relevant",
          }),
          llmEmitsText("ok"),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        promptSuggestionsEnabled: false,
        conversationId: "skill-already-loaded",
      }),
    );

    const call = findFunctionCall(events, "get_skill_content");
    expect(call).toBeDefined();
    expect((call!.data as { input_arguments: unknown }).input_arguments).toEqual({
      slug: "summarize-table",
      reason: "still looks relevant",
    });
  });
});

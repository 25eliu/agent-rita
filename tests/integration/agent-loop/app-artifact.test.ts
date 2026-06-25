/**
 * Tier 2 — create_app in-process execution through the agent loop.
 *
 * Asserts the harness wiring (NOT model behavior — that's a Tier 3 eval):
 *   - Model calls create_app with valid refs → an `app` artifact lands on the
 *     answer stream as a copilotMessageArtifact; no executeAgentTool round-trip.
 *   - Model calls create_app with an unknown ref → no artifact emitted, the loop
 *     continues from the returned error tool-result and still produces text.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop } from "../../../src/agent/loop";
import type { QueryRequest, SSEEvent, Widget } from "../../../src/protocol/types";
import {
  llmCallsTool,
  llmEmitsText,
  makeSequencedMockLlm,
} from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";

beforeEach(() => clearAllModuleState());

function findFunctionCall(events: SSEEvent[], fn: string): SSEEvent | undefined {
  return events.find(
    (e) =>
      e.event === "copilotFunctionCall" &&
      (e.data as { function?: string }).function === fn,
  );
}

const tickerParam = { name: "symbol", type: "string", description: "" };
const widgets: Widget[] = [
  { uuid: "u-price", origin: "openbb", widget_id: "price", name: "Price", description: "", params: [tickerParam] },
  { uuid: "u-news", origin: "openbb", widget_id: "news", name: "News", description: "", params: [tickerParam] },
];

describe("create_app — in-process execution", () => {
  it("emits an app artifact without an executeAgentTool round-trip", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "build me an Apple dashboard" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("create_app", {
            name: "Apple Overview",
            description: "Price and news for Apple",
            tabs: [
              {
                id: "overview",
                name: "Overview",
                layout: [
                  { origin: "openbb", widget_id: "price", x: 0, y: 0, w: 40, h: 10 },
                  { origin: "openbb", widget_id: "news", x: 0, y: 10, w: 40, h: 8 },
                ],
              },
            ],
          }),
          llmEmitsText("Here is your Apple dashboard."),
        ]),
        allWidgets: widgets,
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "app-1",
      }),
    );

    const artifact = events.find((e) => e.event === "copilotMessageArtifact");
    expect(artifact).toBeDefined();
    const data = artifact!.data as { type: string; name: string; widget_refs: unknown[] };
    expect(data.type).toBe("app");
    expect(data.name).toBe("Apple Overview");
    expect(data.widget_refs.length).toBe(2);
    expect(findFunctionCall(events, "execute_agent_tool")).toBeUndefined();
  });

  it("emits no artifact for an unknown widget ref and still answers", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "build a dashboard" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("create_app", {
            name: "Broken",
            description: "references a ghost widget",
            tabs: [
              {
                id: "t",
                name: "T",
                layout: [{ origin: "openbb", widget_id: "ghost", x: 0, y: 0, w: 40, h: 8 }],
              },
            ],
          }),
          llmEmitsText("Sorry, I could not find that widget."),
        ]),
        allWidgets: widgets,
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "app-2",
      }),
    );

    expect(events.find((e) => e.event === "copilotMessageArtifact")).toBeUndefined();
    const chunk = events.find((e) => e.event === "copilotMessageChunk");
    expect(chunk).toBeDefined();
    expect(findFunctionCall(events, "execute_agent_tool")).toBeUndefined();
  });
});

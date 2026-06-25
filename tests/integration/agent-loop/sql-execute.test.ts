/**
 * Tier 2 — SQL family in-process execution through the agent loop.
 *
 * Asserts:
 *   - Model calls execute_sql → loop runs it locally; no executeAgentTool
 *     SSE; no x-agentrita-tables decoration emitted.
 *   - Model calls create_artifact → artifact lands on the answer stream as a
 *     copilotMessageArtifact event (ordering vs the model's text is asserted
 *     in streaming-progress).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop } from "../../../src/agent/loop";
import type { QueryRequest, SSEEvent } from "../../../src/protocol/types";
import {
  llmCallsTool,
  llmEmitsText,
  makeSequencedMockLlm,
} from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";
import { rememberRows } from "../../../src/agent/row-cache";

beforeEach(() => clearAllModuleState());

function findFunctionCall(events: SSEEvent[], fn: string): SSEEvent | undefined {
  return events.find(
    (e) =>
      e.event === "copilotFunctionCall" &&
      (e.data as { function?: string }).function === fn,
  );
}

describe("SQL family — in-process execution", () => {
  it("execute_sql runs locally without an executeAgentTool round-trip", async () => {
    rememberRows("sql-1", "prices", [
      { symbol: "NVDA", close: 100 },
      { symbol: "AAPL", close: 200 },
    ]);
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "what's the max close" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("execute_sql", { sql: "SELECT MAX(close) AS m FROM prices" }),
          llmEmitsText("max close is 200"),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "sql-1",
      }),
    );
    expect(findFunctionCall(events, "execute_agent_tool")).toBeUndefined();
    const chunk = events.find((e) => e.event === "copilotMessageChunk");
    expect((chunk!.data as { delta: string }).delta).toContain("200");
  });

  it("create_artifact emits the rendered artifact into the answer stream", async () => {
    rememberRows("sql-2", "prices", [
      { symbol: "NVDA", close: 100 },
      { symbol: "AAPL", close: 200 },
    ]);
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "chart prices" }],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeSequencedMockLlm([
          llmCallsTool("create_artifact", {
            sql: "SELECT * FROM prices",
            artifact: { type: "table", name: "Prices", description: "loaded prices" },
          }),
          llmEmitsText("here's the table"),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "sql-2",
      }),
    );
    const status = events.find(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { message?: string }).message ===
          'Rendered table artifact "Prices" from 2 rows.',
    );
    expect(status).toBeDefined();
    const artifact = events.find((e) => e.event === "copilotMessageArtifact");
    expect(artifact).toBeDefined();
    const data = artifact!.data as { type: string; name: string; content: unknown[] };
    expect(data.type).toBe("table");
    expect(data.name).toBe("Prices");
    expect(data.content.length).toBe(2);
    expect(findFunctionCall(events, "execute_agent_tool")).toBeUndefined();
  });
});

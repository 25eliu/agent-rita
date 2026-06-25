import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop } from "../../../src/agent/loop";
import type { QueryRequest, SSEEvent } from "../../../src/protocol/types";
import { llmEmitsText, makeErroringStreamMockLlm, makeMockLlm } from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";

beforeEach(() => clearAllModuleState());

function baseRequest(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return {
    messages: [{ role: "human", content: "hello" }],
    ...overrides,
  };
}

async function run(
  options: Partial<Parameters<typeof runAgentLoop>[0]>,
): Promise<SSEEvent[]> {
  return collectGenerator(
    runAgentLoop({
      request: baseRequest(),
      rawModelId: "openai:gpt-4o-mini",
      model: makeMockLlm(llmEmitsText("hi back")),
      allWidgets: [],
      workspaceState: null,
      generativeUiEnabled: false,
      conversationId: "smoke-1",
      ...options,
    }),
  );
}

describe("runAgentLoop — smoke", () => {
  it("emits a messageChunk and returns when the model finishes with plain text", async () => {
    const events = await run({});
    const types = events.map((e) => e.event);
    expect(types).toContain("copilotMessageChunk");
    const chunk = events.find((e) => e.event === "copilotMessageChunk");
    expect((chunk!.data as { delta: string }).delta).toBe("hi back");
  });

  it("does NOT emit a citation collection when there are no citations to report", async () => {
    const events = await run({});
    expect(events.find((e) => e.event === "copilotCitationCollection")).toBeUndefined();
  });

  it("does NOT emit token usage SSE events — usage/cost is logged server-side only", async () => {
    const events = await run({});
    const hidden = events.find(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { hidden?: boolean }).hidden === true,
    );
    expect(hidden).toBeUndefined();
    const usageMsg = events.find(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        typeof (e.data as { message?: string }).message === "string" &&
        (e.data as { message: string }).message.includes("tokens"),
    );
    expect(usageMsg).toBeUndefined();
  });

  it("emits a visible answer chunk when the model stream errors", async () => {
    const errorText =
      "This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens.";
    const events = await run({
      model: makeErroringStreamMockLlm(new Error(errorText)),
    });

    const reasoningError = events.find(
      (e) =>
        e.event === "copilotStatusUpdate" &&
        (e.data as { message?: string }).message?.includes("Model error:"),
    );
    expect(reasoningError).toBeDefined();
    const chunk = events.find((e) => e.event === "copilotMessageChunk");
    expect(chunk).toBeDefined();
    expect((chunk!.data as { delta: string }).delta).toContain("model returned an error");
    expect((chunk!.data as { delta: string }).delta).toContain("more credits");
  });
});

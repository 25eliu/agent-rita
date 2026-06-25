/**
 * Tier 2 — placeholder-tag strip in the SSE stream.
 *
 * Sanity check: even if the model hallucinates `<artifact_id:…>` /
 * `<copilot_table:…>` / `<rita_artifact…>` style tags from training data,
 * the user-visible `messageChunk` SSE never carries them. Mirrors ada's
 * "no leaked artifact tag" regression.
 *
 * Each case drives the tag SPLIT ACROSS DELTAS (llmEmitsTextInDeltas) — the
 * real streaming shape, where a tag can straddle a delta boundary. The sink's
 * withhold-to-terminator state machine must hold the partial tag until its
 * terminator and never leak the prefix. (The exhaustive every-split invariant
 * lives in tests/unit/.../text-sink.test.ts.)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop } from "../../../src/agent/loop";
import type { QueryRequest, SSEEvent } from "../../../src/protocol/types";
import { llmEmitsTextInDeltas, makeMockLlm } from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";

beforeEach(() => clearAllModuleState());

function chunkText(events: SSEEvent[]): string {
  return events
    .filter((e) => e.event === "copilotMessageChunk")
    .map((e) => (e.data as { delta: string }).delta)
    .join("");
}

describe("streaming — placeholder tags never reach the user", () => {
  it("regression: strips `<artifact_id:UUID>` from the delta even if the model emits it", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "go" }] } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          // Tag split mid-name across deltas: "<arti|fact_id…>" and "</arti|fact_id>".
          llmEmitsTextInDeltas([
            "Result: <arti",
            "fact_id:abcd-1234>see chart</arti",
            "fact_id> done.",
          ]),
        ),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "leak-1",
      }),
    );
    const text = chunkText(events);
    expect(text).not.toMatch(/<\/?artifact_id/i);
    expect(text).toContain("Result:");
    expect(text).toContain("done.");
    expect(text).toContain("see chart");
  });

  it("regression: strips `<copilot_table:…>` and `<rita_artifact…>` tag styles", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "go" }] } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          llmEmitsTextInDeltas([
            "A <copilot_",
            'table:7>foo B <rita_artifact id="x">bar</rita_arti',
            "fact> end",
          ]),
        ),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "leak-2",
      }),
    );
    const text = chunkText(events);
    expect(text).not.toMatch(/<\/?copilot_table/i);
    expect(text).not.toMatch(/<\/?rita_artifact/i);
    expect(text).toContain("foo B ");
    expect(text).toContain("bar");
  });

  it("ordinary prose containing the word 'artifact' is left intact", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "go" }] } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          llmEmitsTextInDeltas([
            "The artifact has ",
            "rendered. Reference its ",
            "uuid for follow-up.",
          ]),
        ),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "leak-3",
      }),
    );
    const text = chunkText(events);
    expect(text).toContain("The artifact has rendered.");
  });

  it("strips hallucinated inline image placeholders from final text", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "go" }] } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          // The <img …> tag (and its base64 data URI) straddles three deltas.
          llmEmitsTextInDeltas([
            "**Trend**\n\n<img src=\"data:image/png;",
            "base64,...\" alt=\"Trend\" ",
            "/>\n\nDone.",
          ]),
        ),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "leak-4",
      }),
    );
    const text = chunkText(events);
    expect(text).toContain("**Trend**");
    expect(text).toContain("Done.");
    expect(text).not.toContain("<img");
    expect(text).not.toContain("data:image");
  });
});

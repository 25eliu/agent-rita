import { describe, it, expect } from "bun:test";
import { buildMessages } from "../../../../src/agent/messages";
import type { QueryRequest } from "../../../../src/protocol/types";

function req(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return { messages: [], ...overrides };
}

describe("buildMessages", () => {
  it("always emits system prompt as the first message", () => {
    const out = buildMessages(req());
    expect(out[0].role).toBe("system");
    expect(typeof out[0].content).toBe("string");
  });

  it("appends a user message containing each selected skill block", () => {
    const out = buildMessages(
      req({
        selected_skills: [
          { slug: "alpha", description: "d", contentMarkdown: "alpha body", source: "model_selected" },
          { slug: "beta", description: "d", contentMarkdown: "beta body", source: "forced_slash" },
        ],
      }),
    );
    expect(out[1].role).toBe("user");
    const c = out[1].content as string;
    expect(c).toContain('<skill name="alpha">');
    expect(c).toContain("alpha body");
    expect(c).toContain('<skill name="beta">');
    expect(c).toContain("beta body");
  });

  it("does not append a skills user message when none are selected", () => {
    const out = buildMessages(req({ selected_skills: [] }));
    expect(out.find((m) => m.role === "user" && (m.content as string).includes("<skill"))).toBeUndefined();
  });

  it("maps human → user, ai → assistant in order", () => {
    const out = buildMessages(
      req({
        messages: [
          { role: "human", content: "hi" },
          { role: "ai", content: "hello" },
          { role: "human", content: "more" },
        ],
      }),
    );
    expect(out.slice(1)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "more" },
    ]);
  });

  it("does not feed raw copilot function-call envelopes back as assistant prose", () => {
    const out = buildMessages(
      req({
        messages: [
          {
            role: "ai",
            content: JSON.stringify({
              function: "get_widget_data",
              input_arguments: {
                data_sources: [{ widget_uuid: "w-1", id: "prices" }],
              },
            }),
          },
          { role: "human", content: "what happened?" },
        ],
      }),
    );
    expect(out.find((m) => m.role === "assistant")).toBeUndefined();
    expect(out.at(-1)).toEqual({ role: "user", content: "what happened?" });
  });

  it("does not feed raw copilot SSE envelopes back as assistant prose", () => {
    const out = buildMessages(
      req({
        messages: [
          {
            role: "ai",
            content: JSON.stringify({
              event: "copilotFunctionCall",
              data: {
                function: "get_widget_data",
                input_arguments: { data_sources: [] },
              },
            }),
          },
          { role: "ai", content: "normal answer" },
        ],
      }),
    );
    expect(out.filter((m) => m.role === "assistant")).toEqual([
      { role: "assistant", content: "normal answer" },
    ]);
  });

  it("preserves normal JSON assistant content that is not protocol", () => {
    const content = JSON.stringify({ summary: "ok", rows: 3 });
    const out = buildMessages(
      req({
        messages: [{ role: "ai", content }],
      }),
    );
    expect(out.at(-1)).toEqual({ role: "assistant", content });
  });

  it("strips artifact and citation placeholders from prior assistant prose", () => {
    const out = buildMessages(
      req({
        messages: [
          {
            role: "ai",
            content:
              "<|start_artifact_id|>artifact-1<|end_artifact_id|>" +
              "Here is the chart." +
              "<|start_citation_id|>citation-1<|end_citation_id|>",
          },
        ],
      }),
    );
    expect(out.at(-1)).toEqual({ role: "assistant", content: "Here is the chart." });
  });

  it("drops ai messages whose content is not a plain string", () => {
    const out = buildMessages(
      req({
        messages: [
          { role: "ai", content: { complex: "object" } as unknown as string },
          { role: "human", content: "hello" },
        ],
      }),
    );
    expect(out.find((m) => m.role === "assistant")).toBeUndefined();
    expect(out.at(-1)).toEqual({ role: "user", content: "hello" });
  });
});

describe("buildMessages — earlier tool results rendered into history", () => {
  type LooseMessages = QueryRequest["messages"];

  function mcpToolMsg(toolName: string, items: Array<{ text: string }>) {
    return {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: { tool_name: toolName, server_id: "rita" },
      data: [{ items }],
    };
  }

  it("renders earlier execute_agent_tool results (artifact ack + text), skipping the live last one", () => {
    const earlier = mcpToolMsg("execute_code", [
      { text: JSON.stringify({ $rita_kind: "sandbox_meta", sandbox_id: "sb-1" }) },
      {
        text: JSON.stringify({
          $rita_kind: "artifact",
          artifact: { type: "html", uuid: "u1", name: "Chart", description: "", content: "<img/>" },
        }),
      },
      { text: "Traceback: KeyError startdate" },
    ]);
    const last = mcpToolMsg("execute_code", [{ text: "LIVE RESULT MARKER" }]);
    const out = buildMessages(
      req({
        messages: [
          { role: "human", content: "chart it" },
          earlier,
          last,
        ] as unknown as LooseMessages,
      }),
    );
    const userContents = out
      .filter((m) => m.role === "user")
      .map((m) => m.content as string);
    const hist = userContents.find((c) => c.includes("Earlier tool result from execute_code"));
    expect(hist).toBeDefined();
    expect(hist).toContain('[Artifact "Chart" (html) delivered to the user');
    expect(hist).toContain("Traceback: KeyError startdate");
    // sandbox_meta is protocol-internal — never model-facing.
    expect(hist).not.toContain("sb-1");
    // The live (last) tool result is injected by the loop with full fidelity,
    // not by buildMessages — no double injection.
    expect(userContents.join("\n")).not.toContain("LIVE RESULT MARKER");
  });

  it("renders a trailing tool result from a PRIOR turn (followed by a human message)", () => {
    const priorTurnResult = mcpToolMsg("execute_code", [{ text: "prior turn outcome" }]);
    const out = buildMessages(
      req({
        messages: [
          { role: "human", content: "first ask" },
          priorTurnResult,
          { role: "human", content: "follow-up" },
        ] as unknown as LooseMessages,
      }),
    );
    const hist = out.find(
      (m) => m.role === "user" && (m.content as string).includes("prior turn outcome"),
    );
    expect(hist).toBeDefined();
  });
});

describe("buildMessages — earlier workspace bridge results rendered into history", () => {
  type LooseMessages = QueryRequest["messages"];

  function bridgeResult(fn: string, input: Record<string, unknown>, status: string, message: string) {
    return {
      role: "tool",
      function: fn,
      input_arguments: input,
      data: [{ status, message }],
    };
  }

  it("renders earlier update_widget results so the model remembers prior mutations, skipping the live last one", () => {
    const first = bridgeResult(
      "update_widget_in_dashboard",
      { widget_uuid: "w-1", config: { data_args: { sector: "technology" } } },
      "success",
      "Widget updated.",
    );
    const last = bridgeResult(
      "update_widget_in_dashboard",
      { widget_uuid: "w-2", config: { data_args: { sector: "technology" } } },
      "success",
      "Widget updated.",
    );
    const out = buildMessages(
      req({
        messages: [
          { role: "human", content: "update parameter sector to technology" },
          first,
          last,
        ] as unknown as LooseMessages,
      }),
    );
    const userContents = out
      .filter((m) => m.role === "user")
      .map((m) => m.content as string);
    const hist = userContents.find((c) => c.includes("Earlier workspace bridge result from update_widget_in_dashboard"));
    expect(hist).toBeDefined();
    expect(hist).toContain("w-1");
    expect(hist).toContain("success: Widget updated.");
    // The live (last) bridge result is injected by the loop via injectFromReboot,
    // not by buildMessages — w-2 must NOT be double-rendered here.
    expect(userContents.some((c) => c.includes("w-2"))).toBe(false);
  });

  it("ignores non-bridge tool functions in this branch", () => {
    const out = buildMessages(
      req({
        messages: [
          { role: "human", content: "hi" },
          bridgeResult("not_a_bridge_command", { x: 1 }, "success", "nope"),
          { role: "human", content: "again" },
        ] as unknown as LooseMessages,
      }),
    );
    const userContents = out
      .filter((m) => m.role === "user")
      .map((m) => m.content as string);
    expect(userContents.some((c) => c.includes("Earlier workspace bridge result"))).toBe(false);
  });
});

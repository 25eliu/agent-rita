import { describe, it, expect } from "bun:test";
import {
  messageChunk,
  reasoningStep,
  planningStep,
  messageArtifact,
  getSkillContent,
  executeAgentTool,
  citationCollection,
  getWidgetData,
  getWidgetDataSsrm,
  parseSuggestions,
  workspaceCommand,
} from "../../../../src/protocol/events";
import type { CopilotArtifact, Widget } from "../../../../src/protocol/types";

describe("messageChunk", () => {
  it("wraps delta in copilotMessageChunk", () => {
    expect(messageChunk("hi")).toEqual({
      event: "copilotMessageChunk",
      data: { delta: "hi" },
    });
  });

  it("regression: strips hallucinated placeholder tags (`<artifact_id:…>` / `<copilot_table:…>`)", () => {
    // Rita's protocol does not use inline artifact tags. If the model
    // hallucinates one from training data — or a future refactor leaks a
    // template placeholder into the streamed text — it must not reach the
    // user. ada catches the same regression in test_context.py.
    const cases = [
      ["see this <artifact_id:abcd-ef12>", "see this "],
      ["<artifact:1234>before<copilot_table:7> after", "before after"],
      ["<rita_artifact id=\"x\">leak</rita_artifact>", "leak"],
      ['Visual Summary\n\n<chart artifact="UNRATE vs GDP"/>', "Visual Summary\n\n"],
      ["<ARTIFACT_ID:upper>", ""],
      ["<|start_artifact_id|>artifact-1<|end_artifact_id|>answer", "answer"],
      ["answer<|start_citation_id|>citation-1<|end_citation_id|>", "answer"],
      ['<img src="data:image/png;base64,..." alt="Chart" />answer', "answer"],
      ["![Chart](data:image/png;base64,... )answer", "answer"],
    ];
    for (const [input, expected] of cases) {
      expect((messageChunk(input).data as { delta: string }).delta).toBe(expected);
    }
  });

  it("does not strip ordinary prose containing the word 'artifact'", () => {
    expect((messageChunk("the artifact rendered correctly").data as { delta: string }).delta)
      .toBe("the artifact rendered correctly");
  });

  it("strips dangling malformed suggestion tag fragments defensively", () => {
    expect((messageChunk("Compare safety trends with workforcesuggestion>").data as { delta: string }).delta)
      .toBe("Compare safety trends with workforce");
    expect((messageChunk("Create a detailed ESG performancesuggestionsuggestions>").data as { delta: string }).delta)
      .toBe("Create a detailed ESG performance");
  });
});

describe("parseSuggestions", () => {
  it("extracts well-formed suggestions and removes the block from visible text", () => {
    expect(
      parseSuggestions(
        "Answer\n\n<suggestions>\n<suggestion>Show revenue</suggestion>\n<suggestion>Show emissions</suggestion>\n</suggestions>",
      ),
    ).toEqual({
      cleanText: "Answer",
      suggestions: ["Show revenue", "Show emissions"],
    });
  });

  it("removes malformed suggestion tails without leaking tag fragments", () => {
    expect(
      parseSuggestions(
        "Answer\n\n<suggestions>\n<suggestion>Compare gender diversity with industrysuggestion>\n<suggestion>Show diversity trends by geography</suggestion>\n<suggestion>Analyze correlation between diversity and businesssuggestionsuggestions>",
      ),
    ).toEqual({
      cleanText: "Answer",
      suggestions: [],
    });
  });

  it("drops malformed suggestion items even when the outer block is closed", () => {
    expect(
      parseSuggestions(
        "Answer\n\n<suggestions><suggestion>Bad suggestionsuggestion><suggestion>Good</suggestion></suggestions>",
      ),
    ).toEqual({
      cleanText: "Answer",
      suggestions: [],
    });
  });
});

describe("reasoningStep", () => {
  it("defaults eventType to INFO and uses reasoning group", () => {
    const e = reasoningStep("step msg");
    expect(e.event).toBe("copilotStatusUpdate");
    expect(e.data.eventType).toBe("INFO");
    expect(e.data.group).toBe("reasoning");
    expect(e.data.message).toBe("step msg");
    expect(e.data.details).toBeUndefined();
    expect(e.data.artifacts).toBeUndefined();
  });

  it("accepts severity, details, and artifacts", () => {
    const artifact = {
      type: "table",
      uuid: "u",
      name: "n",
      description: "d",
      content: [],
    } as CopilotArtifact;
    const e = reasoningStep("warn", "WARNING", { extra: 1 }, [artifact]);
    expect(e.data.eventType).toBe("WARNING");
    expect(e.data.details).toEqual([{ extra: 1 }]);
    expect(e.data.artifacts).toEqual([artifact]);
  });

  it("uses detail arrays directly", () => {
    const e = reasoningStep("matches", "INFO", [{ backend: "b" }, { backend: "c" }]);
    expect(e.data.details).toEqual([{ backend: "b" }, { backend: "c" }]);
  });

  it("omits artifacts key when array is empty", () => {
    const e = reasoningStep("m", "INFO", undefined, []);
    expect(e.data.artifacts).toBeUndefined();
  });
});

describe("planningStep", () => {
  it("uses planning group", () => {
    const e = planningStep("thinking");
    expect(e.event).toBe("copilotStatusUpdate");
    expect(e.data.group).toBe("planning");
    expect(e.data.message).toBe("thinking");
  });

  it("keeps planning details separate from the summary", () => {
    const e = planningStep("Fetching trend", "INFO", "1. load data\n2. chart");
    expect(e.data.message).toBe("Fetching trend");
    expect(e.data.details).toEqual(["1. load data\n2. chart"]);
  });
});

describe("messageArtifact", () => {
  it("emits copilotMessageArtifact with the artifact as data", () => {
    const artifact = {
      type: "html",
      uuid: "u",
      name: "n",
      description: "d",
      content: "<html></html>",
    } as CopilotArtifact;
    const e = messageArtifact(artifact);
    expect(e.event).toBe("copilotMessageArtifact");
    expect(e.data).toEqual(artifact as unknown as Record<string, unknown>);
  });
});

describe("getSkillContent", () => {
  it("emits copilotFunctionCall with slug only when reason is absent", () => {
    const e = getSkillContent("my-skill");
    expect(e.event).toBe("copilotFunctionCall");
    const data = e.data as Record<string, unknown>;
    expect(data.function).toBe("get_skill_content");
    expect(data.input_arguments).toEqual({ slug: "my-skill" });
    expect("extra_state" in data).toBe(false);
  });

  it("includes reason when provided", () => {
    const e = getSkillContent("s", "because");
    const data = e.data as Record<string, unknown>;
    expect(data.input_arguments).toEqual({ slug: "s", reason: "because" });
  });

  it("includes extra_state only when non-empty", () => {
    const empty = getSkillContent("s", undefined, {});
    expect("extra_state" in (empty.data as Record<string, unknown>)).toBe(false);

    const filled = getSkillContent("s", undefined, { intermediate_context: "x" });
    expect((filled.data as Record<string, unknown>).extra_state).toEqual({ intermediate_context: "x" });
  });
});

describe("executeAgentTool", () => {
  it("emits the canonical execute_agent_tool function call", () => {
    const e = executeAgentTool("srv", "tool_a", { x: 1 });
    expect(e.event).toBe("copilotFunctionCall");
    const data = e.data as Record<string, unknown>;
    expect(data.function).toBe("execute_agent_tool");
    expect(data.input_arguments).toEqual({
      server_id: "srv",
      tool_name: "tool_a",
      parameters: { x: 1 },
    });
  });

  it("threads parameters byte-for-byte (decoration keys included)", () => {
    const params = {
      sql: "SELECT 1",
      "x-agentrita-conversation-id": "conv-1",
      "x-agentrita-tables": { t1: [{ a: 1 }] },
    };
    const e = executeAgentTool("srv", "execute_sql", params);
    const data = e.data as Record<string, unknown>;
    expect((data.input_arguments as Record<string, unknown>).parameters).toEqual(params);
  });

  it("includes extra_state only when non-empty", () => {
    const empty = executeAgentTool("s", "t", {}, {});
    expect("extra_state" in (empty.data as Record<string, unknown>)).toBe(false);

    const filled = executeAgentTool("s", "t", {}, { compute_tables_shipped: ["t1"] });
    expect((filled.data as Record<string, unknown>).extra_state).toEqual({
      compute_tables_shipped: ["t1"],
    });
  });
});

describe("citationCollection", () => {
  it("wraps a CitationCollection in copilotCitationCollection", () => {
    const e = citationCollection({ citations: [] });
    expect(e.event).toBe("copilotCitationCollection");
    expect(e.data).toEqual({ citations: [] });
  });
});

function widget(overrides: Partial<Widget> = {}): Widget {
  return {
    uuid: "u-1",
    origin: "openbb",
    widget_id: "wid",
    name: "W",
    description: "",
    params: [],
    ...overrides,
  };
}

describe("getWidgetData", () => {
  it("builds input_args from current_value, falling back to default_value", () => {
    const w = widget({
      params: [
        { name: "symbol", type: "string", description: "", current_value: "AAPL", default_value: "MSFT" },
        { name: "limit", type: "number", description: "", default_value: 5 },
      ],
    });
    const e = getWidgetData([w]);
    const data = e.data as Record<string, unknown>;
    const ds = (data.input_arguments as { data_sources: Array<Record<string, unknown>> }).data_sources;
    expect(ds[0].input_args).toEqual({ symbol: "AAPL", limit: 5 });
  });

  it("merges extraState into extra_state alongside copilot_function_call_arguments", () => {
    const e = getWidgetData([widget()], { compute_tables_shipped: ["t"] });
    const data = e.data as Record<string, unknown>;
    expect(data.extra_state).toMatchObject({
      copilot_function_call_arguments: { widget_queries: [{ widget_uuid: "u-1" }] },
      compute_tables_shipped: ["t"],
    });
  });
});

describe("getWidgetDataSsrm", () => {
  it("includes SSRM defaults plus the inline SQL query", () => {
    const e = getWidgetDataSsrm(widget(), "SELECT 1");
    const data = e.data as Record<string, unknown>;
    const ds = (data.input_arguments as { data_sources: Array<Record<string, unknown>> }).data_sources[0];
    const ssm = ds.ssm_request as Record<string, unknown>;
    expect(ssm.query).toBe("SELECT 1");
    expect(ssm.startRow).toBe(0);
    expect(ssm.endRow).toBe(10000);
    expect(ssm.pivotMode).toBe(false);
  });

  it("attaches sql_query and optional sql_artifact_uuid to extra_state", () => {
    const e = getWidgetDataSsrm(widget(), "SELECT 2", "art-uuid");
    const extra = (e.data as Record<string, unknown>).extra_state as Record<string, unknown>;
    expect(extra.sql_query).toBe("SELECT 2");
    expect(extra.sql_artifact_uuid).toBe("art-uuid");
  });
});

describe("workspaceCommand", () => {
  it.each([
    "add_generative_widget",
    "manage_dashboard",
    "create_widget",
    "update_dashboard_layout",
    "manage_navigation_bar",
  ])("emits copilotFunctionCall with mirrored extra_state for %s", (fnName) => {
    const args = { foo: "bar" };
    const e = workspaceCommand(fnName, args);
    expect(e.event).toBe("copilotFunctionCall");
    const data = e.data as Record<string, unknown>;
    expect(data.function).toBe(fnName);
    expect(data.input_arguments).toEqual(args);
    expect(data.extra_state).toEqual({ copilot_function_call_arguments: args });
  });

  it("emits update_widget verbatim with the native bridge config shape (no legacy remap)", () => {
    // The frontend's useWorkspaceBridgeCommandHandler consumes the bridge
    // command shape directly; the old update_widget_in_dashboard remap
    // dropped ui_args and forked the wire contract per command.
    const args = {
      widget_uuid: "w-1",
      config: {
        data_args: { sector: "Financials" },
        ui_args: null,
      },
    };
    const e = workspaceCommand("update_widget", args);
    expect(e.event).toBe("copilotFunctionCall");
    const data = e.data as Record<string, unknown>;
    expect(data.function).toBe("update_widget");
    expect(data.input_arguments).toEqual(args);
    expect(data.extra_state).toEqual({
      copilot_function_call_arguments: args,
    });
  });

  it("merges extraState alongside copilot_function_call_arguments echo", () => {
    const e = workspaceCommand(
      "manage_dashboard",
      { operation: "create", name: "x" },
      { intermediate_citations: [] },
    );
    const data = e.data as Record<string, unknown>;
    expect(data.extra_state).toEqual({
      copilot_function_call_arguments: { operation: "create", name: "x" },
      intermediate_citations: [],
    });
  });
});

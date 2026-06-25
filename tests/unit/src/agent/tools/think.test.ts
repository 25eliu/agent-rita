import { describe, it, expect } from "bun:test";
import { runLlmThink } from "../../../../../src/agent/tools/think";
import type { SSEEvent } from "../../../../../src/protocol/types";

describe("runLlmThink", () => {
  it("returns the plan text verbatim", () => {
    const artifactQueue: SSEEvent[] = [];
    const out = runLlmThink(
      {
        plan: "1. search\n2. get_widget_data\n3. execute_sql",
        summary: "Planning lookup",
      },
      { artifactQueue },
    );
    expect(out).toBe("1. search\n2. get_widget_data\n3. execute_sql");
  });

  it("emits exactly one planningStep SSE", () => {
    const artifactQueue: SSEEvent[] = [];
    runLlmThink(
      { plan: "step one", summary: "Plan" },
      { artifactQueue },
    );
    expect(artifactQueue).toHaveLength(1);
    expect(artifactQueue[0].event).toBe("copilotStatusUpdate");
    expect((artifactQueue[0].data as { group: string }).group).toBe("planning");
    expect((artifactQueue[0].data as { message: string }).message).toBe("Plan");
    expect((artifactQueue[0].data as { details: string[] }).details).toEqual(["step one"]);
  });

  it("redacts internal tool names and UUIDs from the user-facing planning event", () => {
    const artifactQueue: SSEEvent[] = [];
    runLlmThink(
      {
        summary: "Planning to call get_widget_data for uuid d4997b44-bf63-441c-803d-9eae8fc006c3",
        plan:
          "1. Call get_widget_data on the pinned widget 'Plotly Heatmap with Raw Data' " +
          "(uuid: d4997b44-bf63-441c-803d-9eae8fc006c3) to see its content.\n" +
          "2. Use execute_sql to summarize the loaded rows.",
      },
      { artifactQueue },
    );

    const data = artifactQueue[0].data as { message: string; details: string[] };
    expect(data.message).toBe("Planning to get widget data");
    expect(data.details).toEqual([
      "1. Get widget data on the pinned widget 'Plotly Heatmap with Raw Data' to see its content.\n" +
        "2. Run SQL to summarize the loaded rows.",
    ]);
    expect(JSON.stringify(data)).not.toContain("get_widget_data");
    expect(JSON.stringify(data)).not.toContain("execute_sql");
    expect(JSON.stringify(data)).not.toContain("uuid");
    expect(JSON.stringify(data)).not.toContain("d4997b44-bf63-441c-803d-9eae8fc006c3");
  });

  it("works without an explicit summary", () => {
    const artifactQueue: SSEEvent[] = [];
    runLlmThink({ plan: "bare plan", summary: "Planning" }, { artifactQueue });
    expect(artifactQueue).toHaveLength(1);
  });
});

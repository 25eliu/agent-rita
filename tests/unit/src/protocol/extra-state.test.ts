import { describe, it, expect } from "bun:test";
import {
  COMPUTE_PERMANENTLY_UNAVAILABLE,
  readExtraState,
  makeExtraState,
} from "../../../../src/protocol/extra-state";
import type { ToolMessage } from "../../../../src/protocol/types";

function tm(extra?: Record<string, unknown>): ToolMessage {
  return {
    role: "tool",
    function: "execute_agent_tool",
    input_arguments: {},
    data: [],
    ...(extra ? { extra_state: extra } : {}),
  };
}

describe("COMPUTE_PERMANENTLY_UNAVAILABLE", () => {
  it("is the canonical marker the loop greps for", () => {
    expect(COMPUTE_PERMANENTLY_UNAVAILABLE).toBe("COMPUTE_PERMANENTLY_UNAVAILABLE");
  });
});

describe("readExtraState", () => {
  it("returns {} when extra_state is missing", () => {
    expect(readExtraState(tm())).toEqual({});
  });

  it("returns {} when extra_state is not an object", () => {
    expect(readExtraState({ ...tm(), extra_state: "string" as unknown as Record<string, unknown> })).toEqual({});
  });

  it("returns the raw object when shape is correct", () => {
    const e = { intermediate_context: "ctx", compute_tables_shipped: ["t1"] };
    expect(readExtraState(tm(e))).toEqual(e);
  });
});

describe("makeExtraState", () => {
  it("drops null and undefined values", () => {
    const out = makeExtraState({
      intermediate_context: "x",
      sql_query: undefined,
      sql_artifact_uuid: null as unknown as string | undefined,
    });
    expect(out).toEqual({ intermediate_context: "x" });
  });

  it("drops empty arrays", () => {
    const out = makeExtraState({
      intermediate_citations: [],
      compute_tables_shipped: ["t1"],
    });
    expect(out).toEqual({ compute_tables_shipped: ["t1"] });
  });

  it("drops empty plain objects but keeps non-empty ones", () => {
    const out = makeExtraState({
      copilot_function_call_arguments: {},
    });
    expect(out).toEqual({});

    const out2 = makeExtraState({
      copilot_function_call_arguments: { a: 1 },
    });
    expect(out2).toEqual({ copilot_function_call_arguments: { a: 1 } });
  });

  it("returns {} when every field is empty", () => {
    expect(makeExtraState({})).toEqual({});
  });
});

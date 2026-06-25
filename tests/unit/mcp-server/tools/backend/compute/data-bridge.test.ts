import { describe, it, expect } from "bun:test";
import { readDecoration } from "../../../../../../mcp-server/src/tools/backend/compute/data-bridge";

describe("readDecoration", () => {
  it("requires x-agentrita-conversation-id", () => {
    expect(() => readDecoration({})).toThrow(/missing x-agentrita-conversation-id/);
    expect(() => readDecoration({ "x-agentrita-conversation-id": "" })).toThrow();
    expect(() => readDecoration({ "x-agentrita-conversation-id": 123 as unknown })).toThrow();
  });

  it("returns conversationId and undefined tables when no tables shipped", () => {
    expect(readDecoration({ "x-agentrita-conversation-id": "c1" })).toEqual({
      conversationId: "c1",
      tables: undefined,
    });
  });

  it("preserves tables when shape is correct", () => {
    const out = readDecoration({
      "x-agentrita-conversation-id": "c1",
      "x-agentrita-tables": { prices: [{ a: 1 }] },
    });
    expect(out.tables).toEqual({ prices: [{ a: 1 }] });
  });

  it("filters non-array entries from tables and drops if all filtered", () => {
    const out = readDecoration({
      "x-agentrita-conversation-id": "c1",
      "x-agentrita-tables": { ok: [{ a: 1 }], notArray: "string" as unknown },
    });
    expect(out.tables).toEqual({ ok: [{ a: 1 }] });

    const empty = readDecoration({
      "x-agentrita-conversation-id": "c1",
      "x-agentrita-tables": { notArray: "string" as unknown },
    });
    expect(empty.tables).toBeUndefined();
  });

  it("ignores arrays or null in the tables param", () => {
    const out = readDecoration({
      "x-agentrita-conversation-id": "c1",
      "x-agentrita-tables": [1, 2, 3] as unknown,
    });
    expect(out.tables).toBeUndefined();

    const nullTables = readDecoration({
      "x-agentrita-conversation-id": "c1",
      "x-agentrita-tables": null as unknown,
    });
    expect(nullTables.tables).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { SSEEvent, CopilotArtifact } from "../../../../../src/protocol/types";
import type { TableInfo } from "../../../../../src/sql/loader";

let nextLlm: () => Promise<string> = async () => "[]";

mock.module("../../../../../src/lib/llm", () => ({
  singleShotLlm: async () => nextLlm(),
  parseJsonResponse: <T>(raw: string, fallback: T): T => {
    const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      return fallback;
    }
  },
  truncate: (s: string, max: number) => (s.length > max ? s.slice(0, max) + "..." : s),
}));

const { runTableFromText } = await import(
  "../../../../../src/agent/tools/table-from-text"
);

beforeEach(() => {
  nextLlm = async () => "[]";
});

describe("runTableFromText", () => {
  it("loads extracted rows into pendingTables and emits a table artifact", async () => {
    nextLlm = async () =>
      JSON.stringify([
        { quarter: "Q1", revenue: 100 },
        { quarter: "Q2", revenue: 120 },
      ]);
    const pendingTables = new Map<string, Record<string, unknown>[]>();
    const artifactQueue: SSEEvent[] = [];
    const tables: TableInfo[] = [];
    const out = await runTableFromText(
      {
        text: "Quarterly revenue: Q1 100, Q2 120",
        name: "revenue",
        description: "Quarterly revenue",
      },
      { pendingTables, tablesShipped: new Set<string>(), artifactQueue, tables, conversationId: "test" },
    );
    expect(out).toMatch(/Extracted 2 rows/);
    expect(pendingTables.size).toBe(1);
    const tableName = [...pendingTables.keys()][0];
    expect(pendingTables.get(tableName)).toHaveLength(2);
    expect(artifactQueue).toHaveLength(1);
    const artifact = artifactQueue[0].data as unknown as CopilotArtifact;
    expect(artifact.type).toBe("table");
  });

  it("returns a helpful message + no state change when LLM returns nothing parseable", async () => {
    nextLlm = async () => "no table here";
    const pendingTables = new Map<string, Record<string, unknown>[]>();
    const artifactQueue: SSEEvent[] = [];
    const tables: TableInfo[] = [];
    const out = await runTableFromText(
      { text: "blah", name: "x", description: "x" },
      { pendingTables, tablesShipped: new Set<string>(), artifactQueue, tables, conversationId: "test" },
    );
    expect(out).toMatch(/Could not extract/);
    expect(pendingTables.size).toBe(0);
    expect(artifactQueue).toHaveLength(0);
  });

  it("caps rows at 500", async () => {
    const big = Array.from({ length: 800 }, (_, i) => ({ i }));
    nextLlm = async () => JSON.stringify(big);
    const pendingTables = new Map<string, Record<string, unknown>[]>();
    const artifactQueue: SSEEvent[] = [];
    const tables: TableInfo[] = [];
    await runTableFromText(
      { text: "x", name: "big", description: "big" },
      { pendingTables, tablesShipped: new Set<string>(), artifactQueue, tables, conversationId: "test" },
    );
    const stored = pendingTables.get([...pendingTables.keys()][0]);
    expect(stored).toHaveLength(500);
  });
});

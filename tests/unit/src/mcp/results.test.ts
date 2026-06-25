import { describe, it, expect, beforeEach } from "bun:test";
import {
  processMcpResult,
  type McpResultContext,
} from "../../../../src/mcp/results";
import type { ToolMessage } from "../../../../src/protocol/types";

function freshCtx(conversationId = "conv-test"): McpResultContext {
  return {
    tables: [],
    artifactQueue: [],
    citations: [],
    messages: [],
    pendingTables: new Map(),
    tablesShipped: new Set(),
    conversationId,
  };
}

function toolMsg(items: Array<{ text?: string; content?: string }>, fn = "tool-1"): ToolMessage {
  return {
    role: "tool",
    function: "execute_agent_tool",
    input_arguments: { tool_name: fn, server_id: "rita-tools" },
    data: [{ items }],
  };
}

beforeEach(() => {
  // Clear module-level row cache (declared globally in src/agent/row-cache.ts)
  // so each test runs against a clean slate.
  (globalThis as { __rita_chat_row_cache?: Map<string, unknown> })
    .__rita_chat_row_cache?.clear();
});

describe("processMcpResult — plain text", () => {
  it("injects plain text as a user message", () => {
    const ctx = freshCtx();
    const summary = processMcpResult(toolMsg([{ text: "hello world" }]), ctx);
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].role).toBe("user");
    expect(ctx.messages[0].content).toContain("hello world");
    expect(summary.toolName).toBe("tool-1");
    expect(summary.serverId).toBe("rita-tools");
  });

  it("falls back to `content` field when `text` is absent", () => {
    const ctx = freshCtx();
    processMcpResult(toolMsg([{ content: "alt path" }]), ctx);
    expect(ctx.messages[0].content).toContain("alt path");
  });

  it("ignores empty/missing text items", () => {
    const ctx = freshCtx();
    processMcpResult(toolMsg([{ text: "" }, {}]), ctx);
    expect(ctx.messages).toHaveLength(0);
  });

  it("concatenates multiple text items with blank-line separator", () => {
    const ctx = freshCtx();
    processMcpResult(toolMsg([{ text: "first" }, { text: "second" }]), ctx);
    expect(ctx.messages[0].content).toContain("first\n\nsecond");
  });

  it("emits no message when data array is empty", () => {
    const ctx = freshCtx();
    processMcpResult({ ...toolMsg([]), data: [] }, ctx);
    expect(ctx.messages).toHaveLength(0);
  });
});

describe("processMcpResult — $rita_kind: artifact", () => {
  it("pushes a copilotMessageArtifact event onto the queue", () => {
    const ctx = freshCtx();
    const artifact = {
      type: "table",
      uuid: "u1",
      name: "T",
      description: "d",
      content: [{ a: 1 }],
    };
    processMcpResult(
      toolMsg([{ text: JSON.stringify({ $rita_kind: "artifact", artifact }) }]),
      ctx,
    );
    expect(ctx.artifactQueue).toHaveLength(1);
    expect(ctx.artifactQueue[0].event).toBe("copilotMessageArtifact");
  });

  it("injects an artifact-delivery ack into the LLM message so the model knows it succeeded", () => {
    const ctx = freshCtx();
    const artifact = {
      type: "html",
      uuid: "u9",
      name: "Top Chart",
      description: "d",
      content: "<img/>",
    };
    const summary = processMcpResult(
      toolMsg([{ text: JSON.stringify({ $rita_kind: "artifact", artifact }) }]),
      ctx,
    );
    expect(summary.artifactCount).toBe(1);
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('[Artifact "Top Chart" (html) delivered to the user');
  });
});

describe("processMcpResult — $rita_kind: artifact — empty content guard", () => {
  it("skips artifact with empty HTML content string", () => {
    const ctx = freshCtx();
    const artifact = { type: "html", uuid: "u1", name: "Empty", description: "d", content: "" };
    processMcpResult(
      toolMsg([{ text: JSON.stringify({ $rita_kind: "artifact", artifact }) }]),
      ctx,
    );
    expect(ctx.artifactQueue).toHaveLength(0);
  });

  it("skips artifact with empty table content array", () => {
    const ctx = freshCtx();
    const artifact = { type: "table", uuid: "u2", name: "Empty", description: "d", content: [] };
    processMcpResult(
      toolMsg([{ text: JSON.stringify({ $rita_kind: "artifact", artifact }) }]),
      ctx,
    );
    expect(ctx.artifactQueue).toHaveLength(0);
  });

  it("allows artifact with non-empty HTML content", () => {
    const ctx = freshCtx();
    const artifact = { type: "html", uuid: "u3", name: "Chart", description: "d", content: "<div>ok</div>" };
    processMcpResult(
      toolMsg([{ text: JSON.stringify({ $rita_kind: "artifact", artifact }) }]),
      ctx,
    );
    expect(ctx.artifactQueue).toHaveLength(1);
  });

  it("allows artifact with non-empty table content", () => {
    const ctx = freshCtx();
    const artifact = { type: "table", uuid: "u4", name: "T", description: "d", content: [{ a: 1 }] };
    processMcpResult(
      toolMsg([{ text: JSON.stringify({ $rita_kind: "artifact", artifact }) }]),
      ctx,
    );
    expect(ctx.artifactQueue).toHaveLength(1);
  });
});

describe("processMcpResult — $rita_kind: citation", () => {
  it("web citation with explicit id", () => {
    const ctx = freshCtx();
    processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "citation",
            citation: { type: "web", url: "https://x", title: "X", id: "fixed-1" },
          }),
        },
      ]),
      ctx,
    );
    expect(ctx.citations).toHaveLength(1);
    expect(ctx.citations[0]).toMatchObject({ id: "fixed-1", type: "web", url: "https://x", title: "X" });
  });

  it("web citation without id assigns a uuid", () => {
    const ctx = freshCtx();
    processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "citation",
            citation: { type: "web", url: "https://x", title: "X" },
          }),
        },
      ]),
      ctx,
    );
    expect(ctx.citations[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("document citation includes page when present", () => {
    const ctx = freshCtx();
    processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "citation",
            citation: { type: "document", uri: "doc://a", title: "A", page: 7, id: "d-1" },
          }),
        },
      ]),
      ctx,
    );
    const cit = ctx.citations[0];
    expect(cit.type).toBe("document");
    if (cit.type === "document") {
      expect(cit.uri).toBe("doc://a");
      expect(cit.page).toBe(7);
    }
  });

  it("document citation omits page when absent", () => {
    const ctx = freshCtx();
    processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "citation",
            citation: { type: "document", uri: "doc://b", title: "B" },
          }),
        },
      ]),
      ctx,
    );
    const cit = ctx.citations[0];
    if (cit.type === "document") {
      expect("page" in cit).toBe(false);
    }
  });
});

describe("processMcpResult — $rita_kind: sqlite_table", () => {
  it("loads non-empty rows into tables + pendingTables and emits preview text", () => {
    const ctx = freshCtx();
    processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "sqlite_table",
            name: "Prices",
            rows: [{ symbol: "NVDA", close: 100 }, { symbol: "AAPL", close: 200 }],
          }),
        },
      ]),
      ctx,
    );
    expect(ctx.tables).toHaveLength(1);
    expect(ctx.tables[0].rowCount).toBe(2);
    expect(ctx.pendingTables.has(ctx.tables[0].tableName)).toBe(true);
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain("rows available as table");
    expect(ctx.messages[0].content).toContain("execute_sql");
  });

  it("ignores empty-row tables", () => {
    const ctx = freshCtx();
    processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "sqlite_table",
            name: "Empty",
            rows: [],
          }),
        },
      ]),
      ctx,
    );
    expect(ctx.tables).toHaveLength(0);
    expect(ctx.pendingTables.size).toBe(0);
    expect(ctx.messages).toHaveLength(0);
  });

  it("invalidates tablesShipped when overwriting an existing pendingTables entry", () => {
    const ctx = freshCtx();
    // Seed pendingTables + tablesShipped via a first sqlite_table dispatch so
    // the key matches whatever analyzeTable produces (sanitization-aware).
    processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "sqlite_table",
            name: "Prices",
            rows: [{ symbol: "AAPL", close: 100 }],
          }),
        },
      ]),
      ctx,
    );
    const tableName = ctx.tables[0].tableName;
    ctx.tablesShipped.add(tableName);
    // Second dispatch overwrites the same name with fresh rows.
    processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "sqlite_table",
            name: "Prices",
            rows: [{ symbol: "MSFT", close: 500 }],
          }),
        },
      ]),
      ctx,
    );
    expect(ctx.pendingTables.get(tableName)).toEqual([{ symbol: "MSFT", close: 500 }]);
    expect(ctx.tablesShipped.has(tableName)).toBe(false);
  });
});

describe("processMcpResult — $rita_kind: sandbox_meta", () => {
  it("captures sandbox_id into summary and emits no text/message", () => {
    const ctx = freshCtx();
    const summary = processMcpResult(
      toolMsg([{ text: JSON.stringify({ $rita_kind: "sandbox_meta", sandbox_id: "sb-abc" }) }]),
      ctx,
    );
    expect(summary.sandboxId).toBe("sb-abc");
    expect(ctx.messages).toHaveLength(0);
    expect(ctx.tables).toHaveLength(0);
    expect(ctx.artifactQueue).toHaveLength(0);
  });

  it("summary.sandboxId is undefined when no sandbox_meta item is present", () => {
    const ctx = freshCtx();
    const summary = processMcpResult(toolMsg([{ text: "hi" }]), ctx);
    expect(summary.sandboxId).toBeUndefined();
  });

  it("sandbox_meta + other items both processed, sandboxId still captured", () => {
    const ctx = freshCtx();
    const summary = processMcpResult(
      toolMsg([
        { text: JSON.stringify({ $rita_kind: "sandbox_meta", sandbox_id: "sb-xyz" }) },
        { text: "some prose" },
      ]),
      ctx,
    );
    expect(summary.sandboxId).toBe("sb-xyz");
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain("some prose");
  });

  it("sandbox_meta with empty/invalid sandbox_id is ignored (summary.sandboxId stays undefined)", () => {
    const ctx = freshCtx();
    const summary = processMcpResult(
      toolMsg([{ text: JSON.stringify({ $rita_kind: "sandbox_meta", sandbox_id: "" }) }]),
      ctx,
    );
    expect(summary.sandboxId).toBeUndefined();
  });
});

describe("processMcpResult — $rita_kind: error", () => {
  it("emits an error preview text", () => {
    const ctx = freshCtx();
    const summary = processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "error",
            error: { code: "TIMEOUT", message: "took too long", retryable: true },
          }),
        },
      ]),
      ctx,
    );
    expect(summary.errorCount).toBe(1);
    expect(ctx.messages[0].content).toContain("[ERROR TIMEOUT retryable]");
    expect(ctx.messages[0].content).toContain("took too long");
  });

  it("non-retryable error omits the retryable tag", () => {
    const ctx = freshCtx();
    processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "error",
            error: { code: "FATAL", message: "boom" },
          }),
        },
      ]),
      ctx,
    );
    expect(ctx.messages[0].content).toContain("[ERROR FATAL]");
    expect(ctx.messages[0].content).not.toContain("retryable");
  });

  it("does not append retry guidance for errors with details", () => {
    const ctx = freshCtx();
    processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "error",
            error: { code: "BAD_INPUT", message: "missing field 'symbol'" },
          }),
        },
      ]),
      ctx,
    );
    expect(ctx.messages[0].content).toContain("missing field 'symbol'");
    expect(ctx.messages[0].content).not.toContain("Use this error to adjust");
    expect(ctx.messages[0].content).not.toContain("No diagnostic returned");
  });

  it("does not append retry guidance for errors without details", () => {
    const ctx = freshCtx();
    processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "error",
            error: { code: "OPAQUE", message: "" },
          }),
        },
      ]),
      ctx,
    );
    expect(ctx.messages[0].content).toContain("[ERROR OPAQUE]");
    expect(ctx.messages[0].content).not.toContain("No diagnostic returned");
    expect(ctx.messages[0].content).not.toContain("Use this error to adjust");
  });
});

describe("processMcpResult — $rita_kind: model_context", () => {
  it("replaces all plain text in the LLM message", () => {
    const ctx = freshCtx();
    processMcpResult(
      toolMsg([
        { text: "ignored prose" },
        { text: JSON.stringify({ $rita_kind: "model_context", summary: "use this only" }) },
      ]),
      ctx,
    );
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain("use this only");
    expect(ctx.messages[0].content).not.toContain("ignored prose");
  });

  it("last model_context wins when multiple are emitted", () => {
    const ctx = freshCtx();
    processMcpResult(
      toolMsg([
        { text: JSON.stringify({ $rita_kind: "model_context", summary: "first" }) },
        { text: JSON.stringify({ $rita_kind: "model_context", summary: "second" }) },
      ]),
      ctx,
    );
    expect(ctx.messages[0].content).toContain("second");
    expect(ctx.messages[0].content).not.toContain("first");
  });
});

describe("processMcpResult — payload normalization regressions (ada normalize_jsonish parity)", () => {
  // Ada's `normalize_jsonish` covers a 12-case parametrized matrix for
  // plain-text vs double-stringified vs single-element-list payloads. The
  // mirror here ensures workspace's quirks (flattening content[] into a
  // single JSON-stringified text item, etc.) never throw and route to the
  // correct dispatch.

  type Case = { name: string; text: string; assert: (ctx: McpResultContext) => void };

  const cases: Case[] = [
    {
      name: "plain prose passes through to messages",
      text: "hello world",
      assert: (ctx) => {
        expect(ctx.messages.at(0)?.content).toContain("hello world");
        expect(ctx.citations).toHaveLength(0);
      },
    },
    {
      name: "empty string is skipped",
      text: "",
      assert: (ctx) => {
        expect(ctx.messages).toHaveLength(0);
      },
    },
    {
      name: "whitespace-only string passes through (workspace may inject it)",
      text: "   ",
      assert: (ctx) => {
        // Skipped earlier than dispatch — readItemText returns the string but
        // tryParseJson fails and textParts gets the literal whitespace.
        expect(ctx.messages.at(0)?.content).toContain("   ");
      },
    },
    {
      name: "malformed JSON object falls through to text",
      text: "{not valid json",
      assert: (ctx) => {
        expect(ctx.messages.at(0)?.content).toContain("{not valid json");
        expect(ctx.citations).toHaveLength(0);
      },
    },
    {
      name: "JSON with $rita_kind dispatches typed",
      text: JSON.stringify({ $rita_kind: "citation", citation: { type: "web", url: "https://r", title: "R", id: "r-1" } }),
      assert: (ctx) => {
        expect(ctx.citations).toHaveLength(1);
        expect(ctx.messages).toHaveLength(0);
      },
    },
    {
      name: "JSON without $rita_kind falls through to text (raw JSON)",
      text: JSON.stringify({ foo: "bar" }),
      assert: (ctx) => {
        expect(ctx.messages.at(0)?.content).toContain('"foo"');
        expect(ctx.citations).toHaveLength(0);
      },
    },
    {
      name: "double-stringified array recurses element-by-element",
      text: JSON.stringify([
        "first prose",
        JSON.stringify({ $rita_kind: "citation", citation: { type: "web", url: "https://d", title: "D" } }),
        "third prose",
      ]),
      assert: (ctx) => {
        expect(ctx.citations).toHaveLength(1);
        expect(ctx.messages.at(0)?.content).toContain("first prose");
        expect(ctx.messages.at(0)?.content).toContain("third prose");
      },
    },
    {
      name: "single-element array unwraps cleanly",
      text: JSON.stringify(["solo prose"]),
      assert: (ctx) => {
        expect(ctx.messages.at(0)?.content).toContain("solo prose");
      },
    },
    {
      name: "array of typed objects dispatches each",
      text: JSON.stringify([
        { $rita_kind: "citation", citation: { type: "web", url: "https://a", title: "A" } },
        { $rita_kind: "citation", citation: { type: "web", url: "https://b", title: "B" } },
      ]),
      assert: (ctx) => {
        expect(ctx.citations).toHaveLength(2);
      },
    },
  ];

  for (const c of cases) {
    it(`regression: ${c.name}`, () => {
      const ctx = freshCtx();
      processMcpResult(toolMsg([{ text: c.text }]), ctx);
      c.assert(ctx);
    });
  }

  it("regression: multi-item response processes each item independently (no stale state)", () => {
    // Mirrors ada's `parsed_content` reuse bug — looping over data[].items[]
    // must not leak parser state across items.
    const ctx = freshCtx();
    processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "citation",
            citation: { type: "web", url: "https://1", title: "1" },
          }),
        },
        { text: "plain prose" },
        {
          text: JSON.stringify({
            $rita_kind: "citation",
            citation: { type: "web", url: "https://2", title: "2" },
          }),
        },
      ]),
      ctx,
    );
    expect(ctx.citations).toHaveLength(2);
    expect(ctx.messages.at(0)?.content).toContain("plain prose");
  });
});

describe("processMcpResult — flattened content[] (workspace JSON-stringifies the array)", () => {
  it("recurses into stringified array elements and dispatches typed items inside", () => {
    const ctx = freshCtx();
    const flattened = JSON.stringify([
      "plain prose",
      JSON.stringify({
        $rita_kind: "citation",
        citation: { type: "web", url: "https://flat", title: "Flat" },
      }),
    ]);
    processMcpResult(toolMsg([{ text: flattened }]), ctx);
    expect(ctx.citations).toHaveLength(1);
    expect(ctx.messages[0].content).toContain("plain prose");
  });

  it("non-string array element with $rita_kind dispatches directly", () => {
    const ctx = freshCtx();
    const flattened = JSON.stringify([
      { $rita_kind: "citation", citation: { type: "web", url: "https://obj", title: "Obj" } },
    ]);
    processMcpResult(toolMsg([{ text: flattened }]), ctx);
    expect(ctx.citations).toHaveLength(1);
  });
});

describe("processMcpResult — summary", () => {
  it("counts artifacts, citations, tables, errors", () => {
    const ctx = freshCtx();
    const summary = processMcpResult(
      toolMsg([
        {
          text: JSON.stringify({
            $rita_kind: "artifact",
            artifact: { type: "table", uuid: "a", name: "n", description: "d", content: [{ x: 1 }] },
          }),
        },
        {
          text: JSON.stringify({
            $rita_kind: "citation",
            citation: { type: "web", url: "https://x", title: "X" },
          }),
        },
        {
          text: JSON.stringify({
            $rita_kind: "sqlite_table",
            name: "T",
            rows: [{ a: 1 }],
          }),
        },
        {
          text: JSON.stringify({
            $rita_kind: "error",
            error: { code: "E", message: "m" },
          }),
        },
      ]),
      ctx,
    );
    expect(summary.artifactCount).toBe(1);
    expect(summary.citationCount).toBe(1);
    expect(summary.tableCount).toBe(1);
    expect(summary.errorCount).toBe(1);
    expect(summary.hasModelContext).toBe(false);
  });

  it("flags hasModelContext when summary is present", () => {
    const ctx = freshCtx();
    const summary = processMcpResult(
      toolMsg([
        { text: JSON.stringify({ $rita_kind: "model_context", summary: "ctx" }) },
      ]),
      ctx,
    );
    expect(summary.hasModelContext).toBe(true);
  });
});

/**
 * Tier 2 — agent-loop decoration for the document-RAG MCP tools.
 *
 * Mirrors `decoration.test.ts` for execute_code, pinned to:
 *  - `query_documents` and `list_documents` receive both
 *    `x-agentrita-conversation-id` and `x-agentrita-documents` (the delta).
 *  - Already-shipped doc ids restored from `extra_state.documents_shipped`
 *    are NOT re-shipped on the next call.
 *  - `x-agentrita-*` keys are stripped from the model-facing tool schema.
 *  - Unrelated MCP tools do NOT receive the documents decoration.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop, _resetWidgetDataCache } from "../../../src/agent/loop";
import type {
  AgentTool,
  QueryRequest,
  SSEEvent,
  ToolMessage,
  UploadedDocument,
} from "../../../src/protocol/types";
import {
  llmCallsTool,
  llmEmitsText,
  makeMockLlm,
  makeSpyMockLlm,
} from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";

beforeEach(() => {
  clearAllModuleState();
  _resetWidgetDataCache();
});

function ragTools(): AgentTool[] {
  return [
    {
      name: "query_documents",
      server_id: "rita",
      url: "http://localhost:8787/mcp",
      description: "Search uploaded documents",
      input_schema: {
        properties: {
          query: { type: "string" },
          doc_ids: { type: "array", items: { type: "string" } },
          top_k: { type: "number" },
          "x-agentrita-conversation-id": { type: "string" },
          "x-agentrita-documents": { type: "array" },
        },
        required: ["query"],
      },
    },
    {
      name: "list_documents",
      server_id: "rita",
      url: "http://localhost:8787/mcp",
      description: "List uploaded documents",
      input_schema: {
        properties: {
          "x-agentrita-conversation-id": { type: "string" },
          "x-agentrita-documents": { type: "array" },
        },
      },
    },
    {
      name: "fetch_webpage",
      server_id: "rita",
      url: "http://localhost:8787/mcp",
      description: "Fetch a URL",
      input_schema: { properties: { url: { type: "string" } }, required: ["url"] },
    },
  ];
}

function findExecuteAgentTool(events: SSEEvent[], toolName?: string): SSEEvent | undefined {
  for (const e of events) {
    if (e.event !== "copilotFunctionCall") continue;
    const data = e.data as { function?: string; input_arguments?: { tool_name?: string } };
    if (data.function !== "execute_agent_tool") continue;
    if (!toolName || data.input_arguments?.tool_name === toolName) return e;
  }
  return undefined;
}

function payload(e: SSEEvent): {
  tool_name: string;
  parameters: Record<string, unknown>;
  extra_state?: Record<string, unknown>;
} {
  const data = e.data as {
    input_arguments: { tool_name: string; parameters: Record<string, unknown> };
    extra_state?: Record<string, unknown>;
  };
  return {
    tool_name: data.input_arguments.tool_name,
    parameters: data.input_arguments.parameters,
    extra_state: data.extra_state,
  };
}

const SAMPLE_DOC: UploadedDocument = {
  id: "doc-foo",
  name: "Foo.txt",
  format: "txt",
  content_b64: Buffer.from("Foo Foo. Bar Bar.").toString("base64"),
};
const SECOND_DOC: UploadedDocument = {
  id: "doc-bar",
  name: "Bar.txt",
  format: "txt",
  content_b64: Buffer.from("Bar Bar. Baz Baz.").toString("base64"),
};

describe("document RAG — decoration on first query_documents call", () => {
  it("ships every uploaded doc once, including conversationId", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "what does the doc say about foo?" }],
          tools: ragTools(),
          documents: [SAMPLE_DOC, SECOND_DOC],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          llmCallsTool("query_documents", { query: "foo summary", top_k: 3 }),
        ),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-doc-1",
      }),
    );
    const emit = findExecuteAgentTool(events, "query_documents");
    expect(emit).toBeDefined();
    const p = payload(emit!);
    expect(p.parameters["x-agentrita-conversation-id"]).toBe("conv-doc-1");
    const shipped = p.parameters["x-agentrita-documents"] as Array<{ id: string; name: string }>;
    expect(shipped).toBeDefined();
    expect(shipped.map((d) => d.id).sort()).toEqual(["doc-bar", "doc-foo"]);
    expect(p.extra_state).toMatchObject({
      documents_shipped: expect.arrayContaining(["doc-foo", "doc-bar"]),
    });
  });

  it("list_documents also receives the documents decoration", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "what files do I have?" }],
          tools: ragTools(),
          documents: [SAMPLE_DOC],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("list_documents", {})),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-doc-1b",
      }),
    );
    const emit = findExecuteAgentTool(events, "list_documents");
    expect(emit).toBeDefined();
    const p = payload(emit!);
    expect(p.parameters["x-agentrita-conversation-id"]).toBe("conv-doc-1b");
    const shipped = p.parameters["x-agentrita-documents"] as Array<{ id: string }>;
    expect(shipped.map((d) => d.id)).toEqual(["doc-foo"]);
  });

  it("unrelated MCP tools do not receive any document decoration", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "fetch a page" }],
          tools: ragTools(),
          documents: [SAMPLE_DOC],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("fetch_webpage", { url: "https://example.com" })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-doc-2",
      }),
    );
    const emit = findExecuteAgentTool(events, "fetch_webpage");
    expect(emit).toBeDefined();
    const p = payload(emit!);
    expect("x-agentrita-documents" in p.parameters).toBe(false);
    expect("x-agentrita-conversation-id" in p.parameters).toBe(false);
  });
});

describe("document RAG — delta shipping on subsequent calls", () => {
  it("does not re-ship docs already in extra_state.documents_shipped", async () => {
    const priorTool: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: { tool_name: "query_documents", server_id: "rita" },
      data: [{ items: [{ text: "(prior result)" }] }],
      extra_state: { documents_shipped: ["doc-foo"] },
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "search for bar this time" },
            priorTool,
          ],
          tools: ragTools(),
          documents: [SAMPLE_DOC, SECOND_DOC],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          llmCallsTool("query_documents", { query: "bar baz", top_k: 3 }),
        ),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-doc-3",
      }),
    );
    const emit = findExecuteAgentTool(events, "query_documents");
    expect(emit).toBeDefined();
    const p = payload(emit!);
    const shipped = p.parameters["x-agentrita-documents"] as Array<{ id: string }>;
    expect(shipped).toBeDefined();
    expect(shipped.map((d) => d.id)).toEqual(["doc-bar"]);
    // Cumulative shipped set in extra_state is the union of prior + new.
    expect(p.extra_state?.documents_shipped).toEqual(
      expect.arrayContaining(["doc-foo", "doc-bar"]),
    );
  });

  it("omits x-agentrita-documents entirely once everything has been shipped", async () => {
    const priorTool: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: { tool_name: "query_documents", server_id: "rita" },
      data: [{ items: [{ text: "(prior)" }] }],
      extra_state: { documents_shipped: ["doc-foo"] },
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "ask again" },
            priorTool,
          ],
          tools: ragTools(),
          documents: [SAMPLE_DOC],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("query_documents", { query: "foo" })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-doc-4",
      }),
    );
    const p = payload(findExecuteAgentTool(events, "query_documents")!);
    expect("x-agentrita-documents" in p.parameters).toBe(false);
    // conversation-id always present
    expect(p.parameters["x-agentrita-conversation-id"]).toBe("conv-doc-4");
  });
});

describe("document RAG — x-agentrita-* never reaches the model", () => {
  it("query_documents tool surfaced to doGenerate has no x-agentrita-* keys", async () => {
    const spy = makeSpyMockLlm(llmEmitsText("ok"));
    await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "go" }],
          tools: ragTools(),
          documents: [SAMPLE_DOC],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: spy.model,
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-doc-5",
      }),
    );
    const surfacedTools = spy.calls[0].tools as Record<string, unknown> | undefined;
    expect(surfacedTools).toBeDefined();
    for (const [name, t] of Object.entries(surfacedTools!)) {
      const props = (t as { inputSchema?: { jsonSchema?: { properties?: Record<string, unknown> } } })
        .inputSchema?.jsonSchema?.properties;
      if (!props) continue;
      for (const k of Object.keys(props)) {
        expect(`${name}.${k}: ${k.startsWith("x-agentrita-")}`).toBe(`${name}.${k}: false`);
      }
    }
  });
});

describe("document RAG — file-tier widget bridge", () => {
  it("PDF bytes from a file-* widget land in pendingDocuments and ship on next query_documents", async () => {
    // Workspace ships the file as `widgets.primary` entry. The model then
    // calls get_widget_data for it; the re-POST tool message arrives with
    // base64 bytes. `extractFileTierDocs` adds the doc to pendingDocuments,
    // and the subsequent query_documents call carries it on the wire.
    const fileWidget = {
      uuid: "file-pdf-1",
      origin: "openbb",
      widget_id: "file-pdf-1",
      name: "report.pdf",
      description: "uploaded pdf",
      params: [],
      metadata: { extension: "pdf" },
    };
    const priorTool: ToolMessage = {
      role: "tool",
      function: "get_widget_data",
      input_arguments: { data_sources: [{ widget_uuid: "file-pdf-1" }] },
      data: [
        {
          items: [
            {
              content: Buffer.from("%PDF-1.4 stub").toString("base64"),
              data_format: { data_type: "pdf", filename: "report.pdf" },
            },
          ],
        },
      ],
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "summarize the report" },
            priorTool,
          ],
          tools: ragTools(),
          widgets: { primary: [fileWidget] },
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          llmCallsTool("query_documents", { query: "summary of report" }),
        ),
        allWidgets: [fileWidget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-file-rag-1",
      }),
    );
    const emit = findExecuteAgentTool(events, "query_documents");
    expect(emit).toBeDefined();
    const p = payload(emit!);
    const shipped = p.parameters["x-agentrita-documents"] as Array<{
      id: string;
      name: string;
      format: string;
    }>;
    expect(shipped).toBeDefined();
    expect(shipped).toHaveLength(1);
    expect(shipped[0].id).toBe("file-pdf-1");
    expect(shipped[0].name).toBe("report.pdf");
    expect(shipped[0].format).toBe("pdf");
    expect(p.parameters["x-agentrita-conversation-id"]).toBe("conv-file-rag-1");
  });

  it("ignores file-* widgets whose format is not RAG-eligible (csv stays out of pendingDocuments)", async () => {
    const csvFileWidget = {
      uuid: "file-csv-1",
      origin: "openbb",
      widget_id: "file-csv-1",
      name: "data.csv",
      description: "csv file widget",
      params: [],
      metadata: { extension: "csv" },
    };
    const priorTool: ToolMessage = {
      role: "tool",
      function: "get_widget_data",
      input_arguments: { data_sources: [{ widget_uuid: "file-csv-1" }] },
      data: [
        {
          items: [
            { content: "a,b\n1,2", data_format: { data_type: "csv" } },
          ],
        },
      ],
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "what is in the csv?" },
            priorTool,
          ],
          tools: ragTools(),
          widgets: { primary: [csvFileWidget] },
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          llmCallsTool("query_documents", { query: "csv content" }),
        ),
        allWidgets: [csvFileWidget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-file-rag-2",
      }),
    );
    const emit = findExecuteAgentTool(events, "query_documents");
    const p = payload(emit!);
    expect("x-agentrita-documents" in p.parameters).toBe(false);
  });
});

describe("document RAG — uploaded docs section in system prompt", () => {
  it("model sees a description of attached documents and the query_documents tool", async () => {
    const spy = makeSpyMockLlm(llmEmitsText("ok"));
    await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "tell me about the doc" }],
          tools: ragTools(),
          documents: [SAMPLE_DOC],
        } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: spy.model,
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "conv-doc-6",
      }),
    );
    expect(spy.calls.length).toBeGreaterThan(0);
    const messages = spy.calls[0].messages as Array<{ role: string; content: unknown }>;
    const sys = messages.find((m) => m.role === "system");
    expect(sys).toBeDefined();
    const sysContent = typeof sys!.content === "string"
      ? sys!.content
      : JSON.stringify(sys!.content);
    expect(sysContent).toContain("Uploaded Documents");
    expect(sysContent).toContain("Foo.txt");
    expect(sysContent).toContain("query_documents");
  });
});

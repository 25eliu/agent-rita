/**
 * Tier 2 — file widget round-trip through the loop.
 *
 * Asserts: when a tool re-POST carries an image / PDF widget item, the
 * loop's `injectFromReboot` builds a multi-part user message containing
 * the media `parts`, and the surfaced messages reach the LLM unmodified.
 * Mirrors the production flow when the workspace returns a chart image
 * or PDF report from `get_widget_data`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import * as XLSX from "xlsx";
import { runAgentLoop } from "../../../src/agent/loop";
import type { QueryRequest, ToolMessage, Widget } from "../../../src/protocol/types";
import { llmEmitsText, makeSpyMockLlm } from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";

beforeEach(() => clearAllModuleState());

function makeXlsxB64(rows: Record<string, unknown>[]): string {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" }).toString("base64");
}

const widget: Widget = {
  uuid: "chart-1",
  origin: "openbb",
  widget_id: "chart",
  name: "Sample Chart",
  description: "A chart",
  params: [],
  metadata: { extension: "png" },
};

interface LlmCall {
  messages?: Array<{
    role: string;
    content: unknown;
  }>;
}

function findUserPartsMessage(call: LlmCall): unknown[] | undefined {
  // Find the most recent user message whose content is a parts array.
  const msgs = call.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "user" && Array.isArray(m.content)) {
      return m.content as unknown[];
    }
  }
  return undefined;
}

describe("file widget — image inline content reaches the LLM as ImagePart", () => {
  it("regression: prior tool message with png base64 → next generateText call sees ImagePart", async () => {
    const priorTool: ToolMessage = {
      role: "tool",
      function: "get_widget_data",
      input_arguments: { data_sources: [{ widget_uuid: "chart-1" }] },
      data: [
        {
          items: [
            { content: "Zm9vYmFy", data_format: { data_type: "png" } },
          ],
        },
      ],
    };
    const spy = makeSpyMockLlm(llmEmitsText("looks like a chart"));
    await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "what's in the chart?" },
            priorTool,
          ],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: spy.model,
        allWidgets: [widget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "file-png",
      }),
    );
    expect(spy.calls.length).toBeGreaterThan(0);
    const parts = findUserPartsMessage(spy.calls[0] as LlmCall);
    expect(parts).toBeDefined();
    // The Vercel AI SDK normalizes ImagePart to a file-typed entry with
    // an image/* mediaType for V3 wire compat. Match on mediaType, not type.
    const imagePart = (parts as Array<Record<string, unknown>>).find(
      (p) => typeof p.mediaType === "string" && (p.mediaType as string).startsWith("image/"),
    );
    expect(imagePart).toBeDefined();
    expect((imagePart as { mediaType: string }).mediaType).toBe("image/png");
  });
});

describe("file widget — PDF inline content reaches the LLM as FilePart", () => {
  it("regression: prior tool message with pdf base64 → FilePart with application/pdf in user content", async () => {
    // "%PDF" header in base64 (`JVBERi0=`).
    const priorTool: ToolMessage = {
      role: "tool",
      function: "get_widget_data",
      input_arguments: { data_sources: [{ widget_uuid: "chart-1" }] },
      data: [
        {
          items: [
            {
              content: "JVBERi0xLjQK",
              data_format: { data_type: "pdf", filename: "report.pdf" },
            },
          ],
        },
      ],
    };
    const spy = makeSpyMockLlm(llmEmitsText("ok"));
    await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "summarize the pdf" },
            priorTool,
          ],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: spy.model,
        allWidgets: [widget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "file-pdf",
      }),
    );
    const parts = findUserPartsMessage(spy.calls[0] as LlmCall) ?? [];
    const filePart = (parts as Array<Record<string, unknown>>).find(
      (p) => p.mediaType === "application/pdf",
    );
    expect(filePart).toBeDefined();
    expect((filePart as { filename: string }).filename).toBe("report.pdf");
  });
});

describe("file widget — inline xlsx content reaches LLM as JSON table", () => {
  it("regression: prior tool message with xlsx base64 → next generateText sees structured rows text", async () => {
    const xlsxWidget: Widget = {
      uuid: "xlsx-1",
      origin: "openbb",
      widget_id: "file-xlsx-1",
      name: "Sheet",
      description: "uploaded sheet",
      params: [],
      metadata: { extension: "xlsx" },
    };
    const b64 = makeXlsxB64([{ ticker: "AAPL", price: 200 }]);
    const priorTool: ToolMessage = {
      role: "tool",
      function: "get_widget_data",
      input_arguments: { data_sources: [{ widget_uuid: "xlsx-1" }] },
      data: [
        {
          items: [{ content: b64, data_format: { data_type: "xlsx" } }],
        },
      ],
    };
    const spy = makeSpyMockLlm(llmEmitsText("ok"));
    await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "what's the price?" },
            priorTool,
          ],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: spy.model,
        allWidgets: [xlsxWidget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "file-xlsx",
      }),
    );
    const parts = findUserPartsMessage(spy.calls[0] as LlmCall) ?? [];
    const textPart = (parts as Array<Record<string, unknown>>)
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("\n");
    expect(textPart).toContain("AAPL");
    expect(textPart).toContain("200");
  });
});

describe("file widget — system prompt tags file widgets", () => {
  it("regression: widget metadata.extension === 'pdf' surfaces `[FILE: pdf]` to the model", async () => {
    const pdfWidget: Widget = {
      ...widget,
      uuid: "pdf-1",
      name: "Report",
      metadata: { extension: "pdf" },
    };
    const spy = makeSpyMockLlm(llmEmitsText("ack"));
    await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "look at the report" }],
          widgets: { primary: [pdfWidget] },
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: spy.model,
        allWidgets: [pdfWidget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "file-tag",
      }),
    );
    const sysMsg = (spy.calls[0]?.messages as Array<{ role: string; content: string }> | undefined)
      ?.find((m) => m.role === "system");
    expect(sysMsg?.content).toContain("[FILE: pdf]");
  });
});

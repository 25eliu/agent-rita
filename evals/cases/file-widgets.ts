/**
 * File-widget cases. Exercises the vision / file-attachment path:
 *   1. A widget surfaces a PNG image to the model via `get_widget_data`
 *      tool result; the model should be able to read it and answer
 *      questions grounded in the image content.
 *   2. The system prompt tags file widgets with `[FILE: <ext>]` — covered
 *      in Tier 1 prompt tests; here we verify the model uses the tag to
 *      know it's working with a file rather than tabular data.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { EvalCase } from "../runner";
import type { ToolMessage, Widget } from "../../src/protocol/types";
import { llmJudge, noBadState, toolCalled, toolNeverCalled } from "../graders";
// Use the REAL MCP tool descriptions so the routing decision the model faces
// matches production. If someone reverts the description to one that forbids
// get_widget_data, the cold-pdf case below goes red.
import { queryDocumentsDescription } from "../../mcp-server/src/tools/backend/documents/query-documents";
import { listDocumentsDescription } from "../../mcp-server/src/tools/backend/documents/list-documents";

// Tesla revenue-table image (vendored from openbb-ada test_data). Real
// content the vision model can recognize as a financial table.
const IMAGE_PATH = join(__dirname, "..", "fixtures", "files", "table.png");
const TABLE_PNG_B64 = readFileSync(IMAGE_PATH).toString("base64");

const chartWidget: Widget = {
  uuid: "tesla-revenue-table",
  origin: "openbb",
  widget_id: "revenue_table_image",
  name: "Tesla Revenue Table",
  description: "PNG snapshot of Tesla's quarterly results-of-operations table",
  params: [],
  metadata: { extension: "png" },
};

const IMAGE_LOADED: ToolMessage = {
  role: "tool",
  function: "get_widget_data",
  input_arguments: {
    data_sources: [{ widget_uuid: "tesla-revenue-table" }],
  },
  data: [
    {
      items: [
        {
          content: TABLE_PNG_B64,
          data_format: { data_type: "png" },
        },
      ],
    },
  ],
};

const csvWidget: Widget = {
  uuid: "file-csv-revenue",
  origin: "openbb",
  widget_id: "file-csv-revenue",
  name: "revenue.csv",
  description: "uploaded csv with quarterly revenue",
  params: [],
  metadata: { extension: "csv" },
};

const CSV_LOADED: ToolMessage = {
  role: "tool",
  function: "get_widget_data",
  input_arguments: {
    data_sources: [{ widget_uuid: "file-csv-revenue" }],
  },
  data: [
    {
      items: [
        {
          content:
            "quarter,revenue\nQ1 2024,3621\nQ2 2024,4123\nQ3 2024,4892\nQ4 2024,5125",
          data_format: { data_type: "csv" },
        },
      ],
    },
  ],
};

// A PDF file widget whose bytes are NOT yet loaded (cold doc store). The
// agent only feeds the `query_documents` RAG store by first round-tripping
// through `get_widget_data` (→ extractFileTierDocs → pendingDocuments →
// x-agentrita-documents decoration). Until then the store is empty.
const pdfWidget: Widget = {
  uuid: "file-sso-setup-guide",
  origin: "openbb",
  widget_id: "file-sso-setup-guide",
  name: "Microsoft SSO Setup Guide",
  description: "uploaded PDF — Entra/Azure single sign-on app-registration walkthrough",
  params: [],
  metadata: { extension: "pdf" },
};

// Doc-RAG MCP tools surfaced so the model CAN be tempted to call
// query_documents on a cold store. Descriptions are the REAL prod strings.
const QUERY_DOCS_TOOL = {
  name: "query_documents",
  server_id: "rita",
  url: "http://localhost:8787/mcp",
  description: queryDocumentsDescription,
  input_schema: {
    properties: {
      query: { type: "string" },
      doc_ids: { type: "array" },
    },
    required: ["query"],
  },
};

const LIST_DOCS_TOOL = {
  name: "list_documents",
  server_id: "rita",
  url: "http://localhost:8787/mcp",
  description: listDocumentsDescription,
  input_schema: { properties: {}, required: [] },
};

export const fileWidgetCases: EvalCase[] = [
  {
    id: "cold-pdf-loads-before-rag-query",
    description:
      "A PDF file widget is attached but its bytes are not yet loaded (cold RAG store). " +
      "Asked about its content, the model must call get_widget_data to ingest the file FIRST — " +
      "jumping straight to query_documents hits an empty store (NO_DOCUMENTS_LOADED). " +
      "Reproduces the dashboard-PDF RAG-routing bug. The widget is in `primary` to isolate the " +
      "doc-routing decision from search_widgets discovery.",
    messages: [
      {
        role: "human",
        content: "do any of the attached documents mention a single-page application?",
      },
    ],
    workspace: { primary: [pdfWidget], secondary: [], extra: [] },
    tools: [QUERY_DOCS_TOOL, LIST_DOCS_TOOL],
    trials: 3,
    passRate: 0.6,
    graders: [
      toolCalled("get_widget_data"),
      toolNeverCalled("query_documents"),
      noBadState(),
    ],
  },
  {
    id: "csv-file-loaded-routes-to-sql",
    description:
      "A CSV file widget arrives with revenue rows. The single-shot eval runner cuts at the first round-trip; this case verifies the model picks execute_sql / peek_table on the loaded table rather than re-fetching via get_widget_data.",
    messages: [
      { role: "human", content: "which quarter had the highest revenue?" },
      CSV_LOADED,
    ],
    workspace: { primary: [csvWidget], secondary: [], extra: [] },
    trials: 3,
    passRate: 0.6,
    graders: [
      toolCalled("execute_sql"),
      noBadState(),
    ],
  },
  {
    id: "vision-describes-table-image",
    description:
      "After a widget supplies a PNG of a financial table, the model should describe what the image shows (revenue rows, dollar amounts, or year columns).",
    messages: [
      { role: "human", content: "what does this table show?" },
      IMAGE_LOADED,
    ],
    workspace: { primary: [chartWidget], secondary: [], extra: [] },
    trials: 3,
    passRate: 0.6,
    graders: [
      llmJudge({
        criterion:
          "The agent's response describes content visible in the image: a financial / revenue table, mentions of dollar amounts or year columns (2023 / 2024) or row categories (automotive sales, services, total revenues). Generic non-grounded answers (\"I cannot see images\" / refusing to describe) fail.",
        threshold: 0.6,
      }),
      noBadState(),
    ],
  },
  {
    id: "vision-grounded-numeric-question",
    description:
      "Model answers a specific numeric question by reading the image. Tests that the file content reaches vision rather than being summarized away.",
    messages: [
      { role: "human", content: "what was total revenue in 2024 according to this image?" },
      IMAGE_LOADED,
    ],
    workspace: { primary: [chartWidget], secondary: [], extra: [] },
    trials: 3,
    passRate: 0.5,
    graders: [
      llmJudge({
        criterion:
          "The agent's response cites $21,301 (or $21.3 billion) as 2024 total revenue, drawn from the image. Approximate values within rounding (21.3 / 21,301) pass; wildly off numbers or refusal-to-read responses fail.",
        threshold: 0.6,
      }),
      noBadState(),
    ],
  },
];

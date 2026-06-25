import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MockEmbeddingModelV3 } from "ai/test";
import { queryDocumentsHandler } from "../../../../../../mcp-server/src/tools/backend/documents/query-documents";
import {
  _resetEmbeddingModel,
  _setEmbeddingModelForTest,
} from "../../../../../../mcp-server/src/tools/backend/documents/retrieve";
import { _resetDocStoreState } from "../../../../../../mcp-server/src/tools/backend/documents/store";

const VEC_FOO = [1, 0, 0, 0];
const VEC_BAR = [0, 1, 0, 0];

function utf8B64(s: string): string {
  return Buffer.from(new TextEncoder().encode(s)).toString("base64");
}

function makeFakeEmbed(): MockEmbeddingModelV3 {
  return new MockEmbeddingModelV3({
    doEmbed: async ({ values }) => ({
      embeddings: values.map((v) =>
        v.toLowerCase().includes("foo") ? VEC_FOO : VEC_BAR,
      ),
      warnings: [],
    }),
  });
}

beforeEach(() => {
  _resetDocStoreState();
  _setEmbeddingModelForTest(makeFakeEmbed());
});

afterEach(() => {
  _resetEmbeddingModel();
});

describe("queryDocumentsHandler — guards", () => {
  it("returns MISSING_CONVERSATION_ID error when decoration absent", async () => {
    const res = await queryDocumentsHandler({ query: "hello" });
    expect(res.content).toHaveLength(1);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.$rita_kind).toBe("error");
    expect(parsed.error.code).toBe("MISSING_CONVERSATION_ID");
  });

  it("returns NO_DOCUMENTS_LOADED when conversation has no docs", async () => {
    const res = await queryDocumentsHandler({
      query: "anything",
      "x-agentrita-conversation-id": "c-empty",
    });
    expect(res.content).toHaveLength(1);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.error.code).toBe("NO_DOCUMENTS_LOADED");
  });
});

describe("queryDocumentsHandler — happy path", () => {
  it("ingests new docs from decoration and returns ranked chunks + citations", async () => {
    const res = await queryDocumentsHandler({
      query: "tell me about foo",
      "x-agentrita-conversation-id": "c-1",
      "x-agentrita-documents": [
        {
          id: "d-1",
          name: "FooDoc.txt",
          format: "txt",
          content_b64: utf8B64(
            "Sentence about foo. Another sentence on foo. Conclusion on foo.",
          ),
        },
      ],
    });

    expect(res.content.length).toBeGreaterThanOrEqual(2);
    // first item is markdown text containing the chunks
    expect(res.content[0].text).toContain("Hit 1");
    expect(res.content[0].text).toContain("FooDoc.txt");
    // last item should be a document citation
    const last = JSON.parse(res.content[res.content.length - 1].text);
    expect(last.$rita_kind).toBe("citation");
    expect(last.citation.type).toBe("document");
    expect(last.citation.title).toBe("FooDoc.txt");
  });

  it("filters by doc_ids when provided", async () => {
    // Ingest two docs across two calls; the second call filters to the first.
    await queryDocumentsHandler({
      query: "warmup",
      "x-agentrita-conversation-id": "c-2",
      "x-agentrita-documents": [
        {
          id: "doc-foo",
          name: "Foo.txt",
          format: "txt",
          content_b64: utf8B64("Content about foo. Another foo line."),
        },
        {
          id: "doc-bar",
          name: "Bar.txt",
          format: "txt",
          content_b64: utf8B64("Content about bar. Another bar line."),
        },
      ],
    });
    const filtered = await queryDocumentsHandler({
      query: "any topic",
      doc_ids: ["doc-foo"],
      "x-agentrita-conversation-id": "c-2",
    });
    // Only Foo.txt should appear in the formatted hits/citations
    const allText = filtered.content.map((c) => c.text).join("\n");
    expect(allText).toContain("Foo.txt");
    expect(allText).not.toContain("Bar.txt");
  });

  it("does not re-ingest docs already in the store", async () => {
    const decoration = [
      {
        id: "doc-foo",
        name: "Foo.txt",
        format: "txt" as const,
        content_b64: utf8B64("Content about foo."),
      },
    ];
    const r1 = await queryDocumentsHandler({
      query: "first call",
      "x-agentrita-conversation-id": "c-3",
      "x-agentrita-documents": decoration,
    });
    expect(r1.content.length).toBeGreaterThan(0);

    const r2 = await queryDocumentsHandler({
      query: "second call",
      "x-agentrita-conversation-id": "c-3",
      "x-agentrita-documents": decoration, // re-shipped — should be ignored
    });
    expect(r2.content.length).toBeGreaterThan(0);
    // No "could not be ingested" prefix should appear (decoration was a no-op)
    expect(r2.content[0].text).not.toContain("could not be ingested");
  });
});

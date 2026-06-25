import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MockEmbeddingModelV3 } from "ai/test";
import {
  embedChunks,
  retrieve,
  _resetEmbeddingModel,
  _setEmbeddingModelForTest,
} from "../../../../../../mcp-server/src/tools/backend/documents/retrieve";
import {
  upsertDocument,
  _resetDocStoreState,
  type StoredDocument,
} from "../../../../../../mcp-server/src/tools/backend/documents/store";

/**
 * Build a mock embedding model that maps text → fixed vector via a lookup
 * table. Tests author the table to encode "expected similarity" semantics:
 * matching strings get the same vector, mismatched ones get orthogonal.
 */
function makeMock(byText: Record<string, number[]>): MockEmbeddingModelV3 {
  return new MockEmbeddingModelV3({
    doEmbed: async ({ values }) => ({
      embeddings: values.map((v) => byText[v] ?? new Array(8).fill(0)),
      warnings: [],
    }),
  });
}

const VEC_AAPL = [1, 0, 0, 0, 0, 0, 0, 0];
const VEC_MSFT = [0, 1, 0, 0, 0, 0, 0, 0];
const VEC_FOOTBALL = [0, 0, 1, 0, 0, 0, 0, 0];

beforeEach(() => {
  _resetDocStoreState();
});

afterEach(() => {
  _resetEmbeddingModel();
});

describe("embedChunks", () => {
  it("returns one vector per chunk", async () => {
    _setEmbeddingModelForTest(
      makeMock({ "alpha": VEC_AAPL, "beta": VEC_MSFT }),
    );
    const out = await embedChunks([
      { id: "x:0", docId: "x", index: 0, text: "alpha", tokens: 1 },
      { id: "x:1", docId: "x", index: 1, text: "beta", tokens: 1 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(VEC_AAPL);
    expect(out[1]).toEqual(VEC_MSFT);
  });

  it("returns [] for empty input without calling the model", async () => {
    _setEmbeddingModelForTest(makeMock({}));
    expect(await embedChunks([])).toEqual([]);
  });
});

describe("retrieve — cosine ranking", () => {
  async function seedConvo(): Promise<void> {
    const docA: StoredDocument = {
      id: "doc-aapl",
      name: "AAPL.pdf",
      format: "pdf",
      chunks: [
        { id: "doc-aapl:0", docId: "doc-aapl", index: 0, text: "AAPL revenue grew", tokens: 4 },
      ],
      embeddings: [VEC_AAPL],
      ingestedAt: Date.now(),
    };
    const docB: StoredDocument = {
      id: "doc-msft",
      name: "MSFT.pdf",
      format: "pdf",
      chunks: [
        { id: "doc-msft:0", docId: "doc-msft", index: 0, text: "MSFT cloud growth", tokens: 4 },
      ],
      embeddings: [VEC_MSFT],
      ingestedAt: Date.now(),
    };
    const docC: StoredDocument = {
      id: "doc-sport",
      name: "Football.pdf",
      format: "pdf",
      chunks: [
        { id: "doc-sport:0", docId: "doc-sport", index: 0, text: "soccer match results", tokens: 4 },
      ],
      embeddings: [VEC_FOOTBALL],
      ingestedAt: Date.now(),
    };
    await upsertDocument("c1", docA);
    await upsertDocument("c1", docB);
    await upsertDocument("c1", docC);
  }

  it("orders results by cosine similarity to the query vector", async () => {
    await seedConvo();
    _setEmbeddingModelForTest(makeMock({ "tell me about AAPL": VEC_AAPL }));

    const hits = await retrieve("c1", "tell me about AAPL", { topK: 3 });
    expect(hits).toHaveLength(3);
    expect(hits[0].doc.id).toBe("doc-aapl");
    expect(hits[0].score).toBeCloseTo(1, 4);
    // The two orthogonal docs tie at 0; just check AAPL beats both
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("respects topK by truncating", async () => {
    await seedConvo();
    _setEmbeddingModelForTest(makeMock({ "x": VEC_AAPL }));
    const hits = await retrieve("c1", "x", { topK: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0].doc.id).toBe("doc-aapl");
  });

  it("respects docIds filter", async () => {
    await seedConvo();
    _setEmbeddingModelForTest(makeMock({ "anything": VEC_AAPL }));
    const hits = await retrieve("c1", "anything", {
      topK: 5,
      docIds: ["doc-msft"],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].doc.id).toBe("doc-msft");
  });

  it("returns [] when no docs are loaded for the conversation", async () => {
    _setEmbeddingModelForTest(makeMock({ "x": VEC_AAPL }));
    const hits = await retrieve("never-seen", "x", { topK: 5 });
    expect(hits).toEqual([]);
  });
});

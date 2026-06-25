import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type Redis from "ioredis";
import {
  upsertDocument,
  listDocuments,
  hasDocument,
  iterChunks,
  ensureHydrated,
  _resetDocStoreState,
  MAX_DOCS_PER_CHAT,
  type StoredDocument,
} from "../../../../../../mcp-server/src/tools/backend/documents/store";
import { _setRedisClientForTest } from "../../../../../../mcp-server/src/lib/redis";

function makeDoc(id: string, chunks: number): StoredDocument {
  return {
    id,
    name: `${id}.pdf`,
    format: "pdf",
    chunks: Array.from({ length: chunks }, (_, i) => ({
      id: `${id}:${i}`,
      docId: id,
      index: i,
      text: `chunk ${i} of ${id}`,
      tokens: 8,
    })),
    embeddings: Array.from({ length: chunks }, () => [0.1, 0.2, 0.3]),
    ingestedAt: Date.now(),
  };
}

beforeEach(() => {
  _resetDocStoreState();
});

describe("doc store — basic CRUD", () => {
  it("returns empty list for unknown conversation", () => {
    expect(listDocuments("missing")).toEqual([]);
    expect(hasDocument("missing", "doc-1")).toBe(false);
  });

  it("upserts and lists documents per conversation", async () => {
    await upsertDocument("c1", makeDoc("doc-1", 3));
    await upsertDocument("c1", makeDoc("doc-2", 2));
    await upsertDocument("c2", makeDoc("doc-1", 1));

    const c1Docs = listDocuments("c1");
    expect(c1Docs).toHaveLength(2);
    expect(c1Docs.map((d) => d.id).sort()).toEqual(["doc-1", "doc-2"]);

    const c2Docs = listDocuments("c2");
    expect(c2Docs).toHaveLength(1);
    expect(c2Docs[0].chunks).toHaveLength(1);

    expect(hasDocument("c1", "doc-1")).toBe(true);
    expect(hasDocument("c1", "doc-3")).toBe(false);
    expect(hasDocument("c2", "doc-2")).toBe(false);
  });

  it("overwrites on upsert with same id", async () => {
    await upsertDocument("c1", makeDoc("doc-1", 3));
    await upsertDocument("c1", makeDoc("doc-1", 7));
    const docs = listDocuments("c1");
    expect(docs).toHaveLength(1);
    expect(docs[0].chunks).toHaveLength(7);
  });

  it("iterChunks yields every chunk with its embedding", async () => {
    await upsertDocument("c1", makeDoc("doc-a", 2));
    await upsertDocument("c1", makeDoc("doc-b", 3));
    const triples = [...iterChunks("c1")];
    expect(triples).toHaveLength(5);
    for (const t of triples) {
      expect(t.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(t.chunk.docId).toBe(t.doc.id);
    }
  });
});

describe("doc store — caps", () => {
  it("rejects upsert that would exceed MAX_DOCS_PER_CHAT", async () => {
    for (let i = 0; i < MAX_DOCS_PER_CHAT; i++) {
      await upsertDocument("c1", makeDoc(`doc-${i}`, 1));
    }
    await expect(
      upsertDocument("c1", makeDoc("overflow", 1)),
    ).rejects.toThrow(/Document cap/);
  });

  it("rejects upsert that would exceed chunk cap", async () => {
    await expect(
      upsertDocument("c1", makeDoc("huge", 5001)),
    ).rejects.toThrow(/Chunk cap/);
  });
});

describe("doc store — redis persistence", () => {
  type Mock = {
    hashes: Map<string, Map<string, string>>;
    hset(key: string, field: string, value: string): Promise<number>;
    hgetall(key: string): Promise<Record<string, string>>;
    expire(key: string, ttl: number): Promise<number>;
    expires: Map<string, number>;
  };

  function makeMockRedis(): Mock {
    return {
      hashes: new Map(),
      expires: new Map(),
      async hset(key, field, value) {
        let h = this.hashes.get(key);
        if (!h) {
          h = new Map();
          this.hashes.set(key, h);
        }
        h.set(field, value);
        return 1;
      },
      async hgetall(key) {
        const h = this.hashes.get(key);
        if (!h) return {};
        return Object.fromEntries(h);
      },
      async expire(key, ttl) {
        this.expires.set(key, ttl);
        return 1;
      },
    };
  }

  let mock: Mock;
  beforeEach(() => {
    mock = makeMockRedis();
    _setRedisClientForTest(mock as unknown as Redis);
  });
  afterEach(() => {
    _setRedisClientForTest(undefined);
  });

  it("writes doc + 48h TTL to redis on upsert", async () => {
    await upsertDocument("c1", makeDoc("doc-1", 2));
    const stored = mock.hashes.get("rita:doc:c1");
    expect(stored).toBeDefined();
    expect(stored?.has("doc-1")).toBe(true);
    expect(mock.expires.get("rita:doc:c1")).toBe(48 * 3600);
  });

  it("hydrates in-memory store from redis on ensureHydrated", async () => {
    const doc = makeDoc("doc-r1", 1);
    mock.hashes.set("rita:doc:c2", new Map([["doc-r1", JSON.stringify(doc)]]));

    // Fresh state — nothing in-memory for c2 yet
    expect(listDocuments("c2")).toEqual([]);

    await ensureHydrated("c2");
    const docs = listDocuments("c2");
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe("doc-r1");
    expect(docs[0].chunks).toHaveLength(1);
  });

  it("ensureHydrated is idempotent within a process lifetime", async () => {
    const doc = makeDoc("doc-once", 1);
    mock.hashes.set("rita:doc:c3", new Map([["doc-once", JSON.stringify(doc)]]));

    await ensureHydrated("c3");
    // Mutate redis after first hydration — second call must not reload
    mock.hashes.set(
      "rita:doc:c3",
      new Map([["doc-twice", JSON.stringify(makeDoc("doc-twice", 1))]]),
    );
    await ensureHydrated("c3");
    const docs = listDocuments("c3");
    expect(docs.map((d) => d.id)).toEqual(["doc-once"]);
  });
});

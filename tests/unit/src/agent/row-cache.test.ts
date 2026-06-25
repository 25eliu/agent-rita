import { describe, it, expect, beforeEach } from "bun:test";
import { getCachedRows, rememberRows } from "../../../../src/agent/row-cache";

beforeEach(() => {
  (globalThis as { __rita_chat_row_cache?: Map<string, unknown> })
    .__rita_chat_row_cache?.clear();
});

describe("getCachedRows", () => {
  it("returns empty map when conversationId is empty", () => {
    expect(getCachedRows("").size).toBe(0);
  });

  it("returns empty map when chat has no entry", () => {
    expect(getCachedRows("never-cached").size).toBe(0);
  });

  it("returns a snapshot copy (mutating it does not affect the cache)", () => {
    rememberRows("c1", "t1", [{ a: 1 }]);
    const snap = getCachedRows("c1");
    snap.set("evil", []);
    expect(getCachedRows("c1").has("evil")).toBe(false);
  });
});

describe("rememberRows", () => {
  it("stores rows under tableName scoped to conversationId", () => {
    rememberRows("c1", "t1", [{ a: 1 }, { a: 2 }]);
    const out = getCachedRows("c1");
    expect(out.get("t1")).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("isolates by conversation id", () => {
    rememberRows("c1", "t1", [{ a: 1 }]);
    rememberRows("c2", "t1", [{ b: 2 }]);
    expect(getCachedRows("c1").get("t1")).toEqual([{ a: 1 }]);
    expect(getCachedRows("c2").get("t1")).toEqual([{ b: 2 }]);
  });

  it("overwrites prior rows for the same (chat, table) on subsequent writes", () => {
    rememberRows("c1", "t1", [{ a: 1 }]);
    rememberRows("c1", "t1", [{ a: 2 }, { a: 3 }]);
    expect(getCachedRows("c1").get("t1")).toEqual([{ a: 2 }, { a: 3 }]);
  });

  it("no-ops on missing conversationId", () => {
    rememberRows("", "t1", [{ a: 1 }]);
    expect(getCachedRows("").size).toBe(0);
  });

  it("no-ops on empty rows", () => {
    rememberRows("c1", "t1", []);
    expect(getCachedRows("c1").size).toBe(0);
  });
});

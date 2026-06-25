/**
 * Cache-key contract for the in-process widget data cache. Mirrors ada's
 * `build_context_uuid` invariants — the key must be deterministic on
 * (uuid, inputArgs), invariant under args key-order, and type-strict
 * (string "47" must not collide with number 47).
 */

import { describe, it, expect } from "bun:test";
import { _widgetCacheKey } from "../../../../src/agent/loop";

describe("_widgetCacheKey — determinism", () => {
  it("regression: same uuid + same args → same key", () => {
    expect(_widgetCacheKey("u-1", { x: 1, y: 2 })).toBe(_widgetCacheKey("u-1", { x: 1, y: 2 }));
  });

  it("regression: key is invariant under args key-order", () => {
    expect(_widgetCacheKey("u-1", { x: 1, y: 2 })).toBe(_widgetCacheKey("u-1", { y: 2, x: 1 }));
  });

  it("regression: undefined args and {} produce the same key (no args == empty args)", () => {
    expect(_widgetCacheKey("u-1")).toBe(_widgetCacheKey("u-1", {}));
  });
});

describe("_widgetCacheKey — type-strictness (real bug class — string vs number)", () => {
  it('regression: `"47"` and `47` are different cache keys', () => {
    // ada's analogous test pins this exact case; JSON.stringify keeps the
    // type information so a string-coerced ticker won't accidentally hit a
    // number-keyed cache entry.
    expect(_widgetCacheKey("u-1", { id: "47" })).not.toBe(_widgetCacheKey("u-1", { id: 47 }));
  });

  it("regression: `null` and `undefined` arg values are differentiated by JSON.stringify", () => {
    // JSON.stringify drops undefined fields and keeps null. The cache key
    // therefore distinguishes them — a deliberate `null` is not the same
    // as a missing field.
    const withNull = _widgetCacheKey("u-1", { x: null });
    const withUndefined = _widgetCacheKey("u-1", { x: undefined });
    expect(withNull).not.toBe(withUndefined);
  });
});

describe("_widgetCacheKey — distinctness", () => {
  it("regression: different uuids produce different keys with the same args", () => {
    expect(_widgetCacheKey("u-1", { x: 1 })).not.toBe(_widgetCacheKey("u-2", { x: 1 }));
  });

  it("regression: different args produce different keys for the same uuid", () => {
    expect(_widgetCacheKey("u-1", { x: 1 })).not.toBe(_widgetCacheKey("u-1", { x: 2 }));
  });
});

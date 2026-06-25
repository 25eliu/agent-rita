import { describe, it, expect } from "bun:test";
import {
  splitContext,
  CONTEXT_TEXT_BLOCK_MAX_CHARS,
} from "../../../../src/agent/context";

describe("splitContext", () => {
  it("returns empty result for missing / non-array input", () => {
    expect(splitContext(undefined)).toEqual({ tables: [], textBlocks: [] });
    expect(splitContext(null)).toEqual({ tables: [], textBlocks: [] });
    expect(splitContext("not array")).toEqual({ tables: [], textBlocks: [] });
  });

  it("recognises a parse_as=table JSON array as a structured table", () => {
    const ctx = [
      {
        uuid: "u-1",
        name: "Revenue",
        description: "Quarterly revenue",
        data: {
          items: [
            {
              content: JSON.stringify([
                { quarter: "Q1", revenue: 100 },
                { quarter: "Q2", revenue: 120 },
              ]),
              data_format: { parse_as: "table" },
            },
          ],
        },
      },
    ];
    const out = splitContext(ctx);
    expect(out.tables).toHaveLength(1);
    expect(out.tables[0].name).toBe("ctx_revenue");
    expect(out.tables[0].rows).toHaveLength(2);
    expect(out.textBlocks).toEqual([]);
  });

  it("falls back to JSON-shape detection when parse_as is missing", () => {
    const ctx = [
      {
        name: "rows",
        data: {
          items: [{ content: JSON.stringify([{ a: 1 }]) }],
        },
      },
    ];
    const out = splitContext(ctx);
    expect(out.tables).toHaveLength(1);
    expect(out.tables[0].rows).toEqual([{ a: 1 }]);
  });

  it("treats non-array content as text", () => {
    const ctx = [
      {
        name: "notes",
        description: "user notes",
        data: {
          items: [{ content: "Some long form notes here." }],
        },
      },
    ];
    const out = splitContext(ctx);
    expect(out.tables).toEqual([]);
    expect(out.textBlocks).toHaveLength(1);
    expect(out.textBlocks[0]).toMatchObject({
      name: "notes",
      description: "user notes",
      text: "Some long form notes here.",
    });
  });

  it("emits a text block from description when data is absent", () => {
    const ctx = [
      { name: "Note", description: "Hello there" },
      { name: "Empty", description: "" },
    ];
    const out = splitContext(ctx);
    expect(out.textBlocks).toEqual([
      { name: "Note", description: "Hello there", text: "Hello there" },
    ]);
  });

  it("sanitizes table names to safe identifiers and disambiguates blanks", () => {
    const ctx = [
      { name: "Spaces & punctuation!", data: { items: [{ content: JSON.stringify([{ x: 1 }]) }] } },
      { name: "$$$", data: { items: [{ content: JSON.stringify([{ y: 2 }]) }] } },
    ];
    const out = splitContext(ctx);
    expect(out.tables[0].name).toBe("ctx_spaces_punctuation");
    expect(out.tables[1].name).toBe("ctx_1");
  });

  it("passes text blocks within the cap through unchanged", () => {
    const ctx = [{ name: "n", data: { items: [{ content: "short text" }] } }];
    const out = splitContext(ctx);
    expect(out.textBlocks[0].text).toBe("short text");
  });

  it("truncates oversized text blocks with a marker", () => {
    const big = "x".repeat(CONTEXT_TEXT_BLOCK_MAX_CHARS + 500);
    const ctx = [{ name: "n", data: { items: [{ content: big }] } }];
    const out = splitContext(ctx);
    const text = out.textBlocks[0].text;
    expect(text.startsWith("x".repeat(CONTEXT_TEXT_BLOCK_MAX_CHARS))).toBe(true);
    expect(text).toContain(`[…truncated, original ${big.length} chars]`);
    expect(text.length).toBeLessThan(big.length);
  });

  it("truncates the description-only path too", () => {
    const big = "y".repeat(CONTEXT_TEXT_BLOCK_MAX_CHARS + 100);
    const out = splitContext([{ name: "n", description: big }]);
    expect(out.textBlocks[0].text).toContain("[…truncated, original");
  });

  it("does not truncate structured tables larger than the cap", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: i,
      value: "v".repeat(40),
    }));
    expect(JSON.stringify(rows).length).toBeGreaterThan(CONTEXT_TEXT_BLOCK_MAX_CHARS);
    const ctx = [{ name: "t", data: { items: [{ content: JSON.stringify(rows) }] } }];
    const out = splitContext(ctx);
    expect(out.tables).toHaveLength(1);
    expect(out.tables[0].rows).toHaveLength(500);
    expect(out.textBlocks).toEqual([]);
  });
});

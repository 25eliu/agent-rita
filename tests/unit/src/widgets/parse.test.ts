import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as XLSX from "xlsx";
import {
  extractWidgetItems,
  _classifyItem,
  _imageMediaType,
  _csvToJson,
  _xlsxToJson,
} from "../../../../src/widgets/parse";
import type { ToolMessage, Widget } from "../../../../src/protocol/types";

function makeXlsxBuffer(rows: Record<string, unknown>[]): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
}

function widget(uuid: string, name = "W"): Widget {
  return {
    uuid,
    origin: "openbb",
    widget_id: uuid,
    name,
    description: "",
    params: [],
  };
}

function msg(
  data: ToolMessage["data"],
  queries: Array<{ widget_uuid: string }> = [],
): ToolMessage {
  return {
    role: "tool",
    function: "get_widget_data",
    input_arguments: { data_sources: queries },
    data,
  };
}

describe("extractWidgetItems — empty inputs", () => {
  it("returns empty array when data is undefined", async () => {
    const items = await extractWidgetItems(
      { ...msg([]), data: undefined as unknown as ToolMessage["data"] },
      [],
    );
    expect(items).toEqual([]);
  });

  it("returns empty array when data is empty", async () => {
    const items = await extractWidgetItems(msg([]), []);
    expect(items).toEqual([]);
  });
});

describe("extractWidgetItems — inline text content", () => {
  it("collects content into items keyed by data_sources index", async () => {
    const tm = msg(
      [{ items: [{ content: "hello" }, { content: "world" }] }],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1", "First")]);
    expect(items).toHaveLength(1);
    expect(items[0].uuid).toBe("u-1");
    expect(items[0].name).toBe("First");
    expect(items[0].content).toBe("hello\nworld");
    expect(items[0].parts).toBeUndefined();
  });

  it("uses fallback name when widget UUID is not in allWidgets", async () => {
    const tm = msg([{ items: [{ content: "x" }] }], [{ widget_uuid: "missing" }]);
    const items = await extractWidgetItems(tm, []);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("widget_0");
    expect(items[0].uuid).toBe("missing");
  });

  it("uses fallback uuid when no data_sources entry exists for the index", async () => {
    const tm = msg([{ items: [{ content: "x" }] }], []);
    const items = await extractWidgetItems(tm, []);
    expect(items[0].uuid).toBe("unknown_0");
  });

  it("skips an entry that produces neither content nor media parts", async () => {
    const tm = msg([{ items: [{ content: "" }] }], [{ widget_uuid: "u-1" }]);
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    expect(items).toEqual([]);
  });
});

describe("extractWidgetItems — inline image", () => {
  it("emits an image media part with mediaType from data_format.data_type", async () => {
    const tm = msg(
      [
        {
          items: [
            { content: "Zm9v", data_format: { data_type: "png" } },
          ],
        },
      ],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    expect(items[0].parts).toBeDefined();
    expect(items[0].parts).toHaveLength(1);
    const part = items[0].parts![0] as { type: "image"; mediaType: string; image: string };
    expect(part.type).toBe("image");
    expect(part.mediaType).toBe("image/png");
    expect(part.image).toBe("Zm9v");
  });

  it("defaults image mediaType to image/jpeg for jpg/jpeg", async () => {
    const tm = msg(
      [{ items: [{ content: "abc", data_format: { data_type: "jpg" } }] }],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    const part = items[0].parts![0] as { mediaType: string };
    expect(part.mediaType).toBe("image/jpeg");
  });

  it("skips images larger than the inline base64 limit", async () => {
    const huge = "A".repeat(5 * 1024 * 1024 + 1);
    const tm = msg(
      [{ items: [{ content: huge, data_format: { data_type: "png" } }] }],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    expect(items).toHaveLength(0);
  });
});

describe("_classifyItem — file kind routing", () => {
  it("classifies image data_type variants (case-insensitive)", () => {
    expect(_classifyItem({ data_type: "png" })).toBe("image");
    expect(_classifyItem({ data_type: "PNG" })).toBe("image");
    expect(_classifyItem({ data_type: "jpg" })).toBe("image");
    expect(_classifyItem({ data_type: "JPEG" })).toBe("image");
  });

  it("classifies pdf data_type", () => {
    expect(_classifyItem({ data_type: "pdf" })).toBe("pdf");
    expect(_classifyItem({ data_type: "PDF" })).toBe("pdf");
  });

  it("classifies csv via data_type", () => {
    expect(_classifyItem({ data_type: "csv" })).toBe("csv");
  });

  it("infers csv from URL suffix when data_format missing", () => {
    expect(_classifyItem(undefined, "https://example.com/data.csv")).toBe("csv");
    expect(_classifyItem({}, "https://example.com/data.csv")).toBe("csv");
  });

  it("classifies xlsx via data_type or URL suffix", () => {
    expect(_classifyItem({ data_type: "xlsx" })).toBe("xlsx");
    expect(_classifyItem({ data_type: "xls" })).toBe("xlsx");
    expect(_classifyItem(undefined, "https://example.com/data.xlsx")).toBe("xlsx");
    expect(_classifyItem(undefined, "https://example.com/data.xls")).toBe("xlsx");
  });

  it("regression: docx / txt / md / html / unknown fall through to text", () => {
    // docx / html are handled by the MCP RAG path, not parse.ts. txt / md
    // are treated as plain text by the model. xlsx now has native handling
    // (see test above).
    expect(_classifyItem({ data_type: "docx" })).toBe("text");
    expect(_classifyItem({ data_type: "html" })).toBe("text");
    expect(_classifyItem({ data_type: "txt" })).toBe("text");
    expect(_classifyItem({ data_type: "md" })).toBe("text");
    expect(_classifyItem({ data_type: "unknown_format" })).toBe("text");
    expect(_classifyItem(undefined, undefined)).toBe("text");
  });

  it("data_type wins over URL when both present", () => {
    expect(_classifyItem({ data_type: "pdf" }, "https://example.com/foo.csv")).toBe("pdf");
  });
});

describe("_imageMediaType", () => {
  it("returns image/png for png", () => {
    expect(_imageMediaType("png")).toBe("image/png");
  });

  it("returns image/jpeg fallback for jpg / jpeg / unknown / empty", () => {
    expect(_imageMediaType("jpg")).toBe("image/jpeg");
    expect(_imageMediaType("jpeg")).toBe("image/jpeg");
    expect(_imageMediaType("")).toBe("image/jpeg");
    expect(_imageMediaType("gif")).toBe("image/jpeg");
  });
});

describe("_csvToJson", () => {
  it("parses a simple csv with header and rows", () => {
    const out = JSON.parse(_csvToJson("a,b\n1,2\n3,4"));
    expect(out).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });

  it("coerces numeric cells; leaves non-numeric strings as-is", () => {
    const out = JSON.parse(_csvToJson("symbol,price\nAAPL,200\nNVDA,1000"));
    expect(out).toEqual([
      { symbol: "AAPL", price: 200 },
      { symbol: "NVDA", price: 1000 },
    ]);
  });

  it("returns [] when input has < 2 lines", () => {
    expect(_csvToJson("only-header")).toBe("[]");
    expect(_csvToJson("")).toBe("[]");
  });

  it("strips UTF-8 BOM from header", () => {
    const out = JSON.parse(_csvToJson("﻿a,b\n1,2"));
    expect(out[0]).toHaveProperty("a", 1);
    expect(out[0]).toHaveProperty("b", 2);
  });

  it("handles quoted commas inside fields", () => {
    const out = JSON.parse(_csvToJson('name,note\n"Smith, J",hi'));
    expect(out).toEqual([{ name: "Smith, J", note: "hi" }]);
  });

  it("skips blank rows", () => {
    const out = JSON.parse(_csvToJson("a,b\n1,2\n\n3,4"));
    expect(out).toHaveLength(2);
  });

  it("regression: documented limitation — escaped double-quotes (`\"\"`) flip inQuotes (no escape support)", () => {
    // Pinning current behavior. If we add proper RFC-4180 escape handling
    // later, update parse.ts AND replace this test.
    const out = JSON.parse(_csvToJson('a,b\n"he said ""hi""",ok'));
    // The escaped `""` toggles inQuotes off then on, so the comma inside
    // is treated as a delimiter. We get more cells than expected.
    expect(out[0]).not.toEqual({ a: 'he said "hi"', b: "ok" });
  });

  it("missing trailing values default to empty string", () => {
    const out = JSON.parse(_csvToJson("a,b,c\n1,2"));
    expect(out[0]).toEqual({ a: 1, b: 2, c: "" });
  });
});

describe("extractWidgetItems — URL-based image (production path)", () => {
  it("emits an ImagePart with a URL object instead of base64 when only `url` is set", async () => {
    const tm = msg(
      [
        {
          items: [
            { url: "https://example.com/chart.png", data_format: { data_type: "png" } },
          ],
        },
      ],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    expect(items[0].parts).toHaveLength(1);
    const part = items[0].parts![0] as { type: "image"; image: URL };
    expect(part.type).toBe("image");
    expect(part.image).toBeInstanceOf(URL);
    expect(part.image.href).toBe("https://example.com/chart.png");
  });
});

describe("extractWidgetItems — URL-based PDF / CSV / text (mocked fetch)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(handler: (url: string) => Response | Promise<Response>) {
    globalThis.fetch = ((input: unknown) => {
      const url = input instanceof URL ? input.href : (input as string);
      return Promise.resolve(handler(url));
    }) as unknown as typeof fetch;
  }

  it("PDF URL: fetches, base64-encodes, emits FilePart with inferred filename when not in data_format", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    mockFetch(() => new Response(pdfBytes));
    const tm = msg(
      [
        {
          items: [
            { url: "https://example.com/path/report.pdf", data_format: { data_type: "pdf" } },
          ],
        },
      ],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    const part = items[0].parts![0] as {
      type: "file";
      mediaType: string;
      filename?: string;
      data: string;
    };
    expect(part.type).toBe("file");
    expect(part.mediaType).toBe("application/pdf");
    expect(part.filename).toBe("report.pdf");
    expect(part.data).toBe(Buffer.from(pdfBytes).toString("base64"));
  });

  it("PDF URL: data_format.filename overrides URL-suffix fallback", async () => {
    mockFetch(() => new Response(new Uint8Array([0])));
    const tm = msg(
      [
        {
          items: [
            {
              url: "https://example.com/path/report.pdf",
              data_format: { data_type: "pdf", filename: "explicit.pdf" },
            },
          ],
        },
      ],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    const part = items[0].parts![0] as { filename: string };
    expect(part.filename).toBe("explicit.pdf");
  });

  it("PDF URL: skips when fetched body exceeds size cap", async () => {
    const huge = new Uint8Array(21 * 1024 * 1024);
    mockFetch(() => new Response(huge));
    const tm = msg(
      [{ items: [{ url: "https://x/big.pdf", data_format: { data_type: "pdf" } }] }],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    expect(items).toHaveLength(0);
  });

  it("PDF URL: skips on 4xx response (no part, no throw)", async () => {
    mockFetch(() => new Response("not found", { status: 404 }));
    const tm = msg(
      [{ items: [{ url: "https://x/missing.pdf", data_format: { data_type: "pdf" } }] }],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    expect(items).toHaveLength(0);
  });

  it("PDF URL: swallows fetch errors (no throw, no part)", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    const tm = msg(
      [{ items: [{ url: "https://x/err.pdf", data_format: { data_type: "pdf" } }] }],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    expect(items).toHaveLength(0);
  });

  it("CSV URL: fetches, converts to JSON via _csvToJson, lands as content text", async () => {
    mockFetch(() => new Response("a,b\n1,2\n3,4"));
    const tm = msg(
      [{ items: [{ url: "https://x/data.csv" }] }],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    expect(items[0].content).toContain('"a":1');
    expect(items[0].content).toContain('"b":4');
    expect(items[0].parts).toBeUndefined();
  });

  it("Generic text URL: fetches text and pushes verbatim into content", async () => {
    mockFetch(() => new Response("plain prose body"));
    const tm = msg(
      [{ items: [{ url: "https://x/note.txt" }] }],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    expect(items[0].content).toBe("plain prose body");
  });

  it("Generic URL fetch failure logs but does not throw — item dropped", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("DNS fail"))) as unknown as typeof fetch;
    const tm = msg(
      [{ items: [{ url: "https://nowhere/foo" }] }],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    expect(items).toHaveLength(0);
  });
});

describe("extractWidgetItems — inline PDF", () => {
  it("emits a file media part with application/pdf", async () => {
    const tm = msg(
      [
        {
          items: [
            {
              content: "JVBERi0xLjQK",
              data_format: { data_type: "pdf", filename: "report.pdf" },
            },
          ],
        },
      ],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    const part = items[0].parts![0] as {
      type: "file";
      mediaType: string;
      filename?: string;
    };
    expect(part.type).toBe("file");
    expect(part.mediaType).toBe("application/pdf");
    expect(part.filename).toBe("report.pdf");
  });

  it("skips PDFs whose decoded size exceeds the limit", async () => {
    // Approx: base64 length * 3/4 must exceed 20MB → ~26.7M base64 chars
    const huge = "A".repeat(28 * 1024 * 1024);
    const tm = msg(
      [{ items: [{ content: huge, data_format: { data_type: "pdf" } }] }],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    expect(items).toHaveLength(0);
  });
});

describe("_xlsxToJson", () => {
  it("converts the first sheet to JSON rows", () => {
    const buf = makeXlsxBuffer([
      { ticker: "AAPL", price: 200 },
      { ticker: "MSFT", price: 410 },
    ]);
    const json = _xlsxToJson(buf);
    const rows = JSON.parse(json) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ticker: "AAPL", price: 200 });
    expect(rows[1]).toMatchObject({ ticker: "MSFT", price: 410 });
  });

  it("returns empty array string when the first sheet has no rows", () => {
    const buf = makeXlsxBuffer([]);
    expect(_xlsxToJson(buf)).toBe("[]");
  });
});

describe("extractWidgetItems — xlsx", () => {
  it("decodes inline base64 xlsx into JSON rows in content", async () => {
    const rows = [{ year: 2024, revenue: 21301 }];
    const b64 = makeXlsxBuffer(rows).toString("base64");
    const tm = msg(
      [{ items: [{ content: b64, data_format: { data_type: "xlsx" } }] }],
      [{ widget_uuid: "u-1" }],
    );
    const items = await extractWidgetItems(tm, [widget("u-1")]);
    expect(items).toHaveLength(1);
    expect(items[0].parts).toBeUndefined();
    const parsed = JSON.parse(items[0].content) as Array<Record<string, unknown>>;
    expect(parsed).toEqual([{ year: 2024, revenue: 21301 }]);
  });

  it("fetches xlsx URL and converts to JSON", async () => {
    const buf = makeXlsxBuffer([{ a: 1, b: "x" }]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      arrayBuffer: async () => buf,
    })) as unknown as typeof fetch;
    try {
      const tm = msg(
        [
          {
            items: [
              {
                url: "https://example.com/sheet.xlsx",
                data_format: { data_type: "xlsx" },
              },
            ],
          },
        ],
        [{ widget_uuid: "u-1" }],
      );
      const items = await extractWidgetItems(tm, [widget("u-1")]);
      expect(items).toHaveLength(1);
      const parsed = JSON.parse(items[0].content) as Array<Record<string, unknown>>;
      expect(parsed).toEqual([{ a: 1, b: "x" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("classifies xlsx by URL suffix when data_format is absent", async () => {
    const buf = makeXlsxBuffer([{ q: 1 }]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      arrayBuffer: async () => buf,
    })) as unknown as typeof fetch;
    try {
      const tm = msg(
        [{ items: [{ url: "https://example.com/d.xlsx" }] }],
        [{ widget_uuid: "u-1" }],
      );
      const items = await extractWidgetItems(tm, [widget("u-1")]);
      const parsed = JSON.parse(items[0].content) as Array<Record<string, unknown>>;
      expect(parsed).toEqual([{ q: 1 }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import { describe, it, expect } from "bun:test";
import {
  buildAllCitations,
  citationUuid,
  buildWidgetCitations,
  buildMcpCitations,
  dedupeCitations,
} from "../../../../src/protocol/citations";
import type { Citation, Widget } from "../../../../src/protocol/types";
import type { McpCitation } from "../../../../src/mcp/results";

function widget(overrides: Partial<Widget> = {}): Widget {
  return {
    uuid: "u-1",
    origin: "openbb",
    widget_id: "wid",
    name: "Widget A",
    description: "desc",
    params: [],
    ...overrides,
  };
}

describe("citationUuid", () => {
  it("is deterministic for the same widget uuid + args", async () => {
    const a = await citationUuid("u-1", { x: 1, y: 2 });
    const b = await citationUuid("u-1", { x: 1, y: 2 });
    expect(a).toBe(b);
  });

  it("ignores key order in args", async () => {
    const a = await citationUuid("u-1", { x: 1, y: 2 });
    const b = await citationUuid("u-1", { y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("produces a UUIDv5-shaped string", async () => {
    const id = await citationUuid("u-1", {});
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("differs when widget uuid or args change", async () => {
    const a = await citationUuid("u-1", { x: 1 });
    const b = await citationUuid("u-1", { x: 2 });
    const c = await citationUuid("u-2", { x: 1 });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("buildWidgetCitations", () => {
  it("filters null/undefined/empty-string args from details", async () => {
    const w = widget();
    const cited = new Map([
      ["u-1", { widget: w, inputArgs: { keep: "x", drop_null: null, drop_empty: "", drop_undef: undefined } }],
    ]);
    const out = await buildWidgetCitations(cited);
    expect(out).toHaveLength(1);
    const meta = out[0].source_info as Extract<typeof out[0]["source_info"], { type: "widget" }>;
    expect(meta.metadata.input_args).toEqual({ keep: "x" });
    expect(out[0].details[0]).toMatchObject({
      "Source type": "widget",
      Origin: "openbb",
      "Data source": "Widget A",
      keep: "x",
    });
  });

  it("uses citationUuid as both id and source_info.uuid", async () => {
    const w = widget();
    const cited = new Map([
      ["u-1", { widget: w, inputArgs: { x: 1 } }],
    ]);
    const out = await buildWidgetCitations(cited);
    const expected = await citationUuid("u-1", { x: 1 });
    expect(out[0].id).toBe(expected);
    expect((out[0].source_info as { uuid: string }).uuid).toBe(expected);
  });

  it("uses widgetUuid from the citation value when the map key is request-scoped", async () => {
    const w = widget();
    const cited = new Map([
      ["u-1|{\"symbol\":\"UNRATE\"}", { widget: w, widgetUuid: "u-1", inputArgs: { symbol: "UNRATE" } }],
    ]);
    const out = await buildWidgetCitations(cited);
    const expected = await citationUuid("u-1", { symbol: "UNRATE" });
    expect(out[0].id).toBe(expected);
    const meta = out[0].source_info as Extract<typeof out[0]["source_info"], { type: "widget" }>;
    expect(meta.metadata.widget_uuid).toBe("u-1");
    expect(meta.metadata.input_args).toEqual({ symbol: "UNRATE" });
  });

  it("emits a file-typed citation with Filename in details for file-* widgets", async () => {
    const f = widget({
      uuid: "file-uuid-1",
      widget_id: "file-uuid-1",
      name: "report.pdf",
      metadata: { extension: "pdf" },
    });
    const cited = new Map([
      ["file-uuid-1", { widget: f, inputArgs: {} }],
    ]);
    const out = await buildWidgetCitations(cited);
    expect(out).toHaveLength(1);
    expect(out[0].source_info.type).toBe("file");
    expect((out[0].source_info as { name: string }).name).toBe("report.pdf");
    expect(out[0].details[0]).toMatchObject({
      Filename: "report.pdf",
      Extension: "pdf",
    });
  });

  it("omits Extension when widget has no extension metadata", async () => {
    const f = widget({
      uuid: "file-uuid-2",
      widget_id: "file-uuid-2",
      name: "notes",
    });
    const cited = new Map([
      ["file-uuid-2", { widget: f, inputArgs: {} }],
    ]);
    const out = await buildWidgetCitations(cited);
    expect(out[0].details[0]).toEqual({ Filename: "notes" });
  });
});

describe("buildMcpCitations", () => {
  it("maps a web McpCitation to a web-typed Citation", () => {
    const mcp: McpCitation = { id: "id-1", type: "web", url: "https://x", title: "X" };
    const out = buildMcpCitations([mcp]);
    expect(out).toHaveLength(1);
    expect(out[0].source_info.type).toBe("web");
    expect(out[0].details[0]).toEqual({ link: "https://x", title: "X" });
  });

  it("includes page when document citation has it", () => {
    const mcp: McpCitation = { id: "id-2", type: "document", uri: "doc://a", title: "A", page: 9 };
    const out = buildMcpCitations([mcp]);
    expect(out[0].details[0]).toMatchObject({ link: "doc://a", title: "A", page: 9 });
  });

  it("omits page on document citations without one", () => {
    const mcp: McpCitation = { id: "id-3", type: "document", uri: "doc://b", title: "B" };
    const out = buildMcpCitations([mcp]);
    expect("page" in out[0].details[0]).toBe(false);
  });
});

describe("dedupeCitations", () => {
  it("keeps the first occurrence of a widget citation by widget_uuid + input_args", async () => {
    const w = widget();
    const a = await buildWidgetCitations(new Map([["u-1", { widget: w, inputArgs: { p: 1 } }]]));
    const b = await buildWidgetCitations(new Map([["u-1", { widget: w, inputArgs: { p: 1 } }]]));
    const out = dedupeCitations([...a, ...b]);
    expect(out).toHaveLength(1);
  });

  it("keeps duplicates that differ on input_args", async () => {
    const w = widget();
    const a = await buildWidgetCitations(new Map([["u-1", { widget: w, inputArgs: { p: 1 } }]]));
    const b = await buildWidgetCitations(new Map([["u-1", { widget: w, inputArgs: { p: 2 } }]]));
    expect(dedupeCitations([...a, ...b])).toHaveLength(2);
  });

  it("dedupes web citations by their link (details[0].link)", () => {
    const cits: Citation[] = [
      {
        id: "1",
        source_info: { type: "web", name: "A", citable: true },
        details: [{ link: "https://x", title: "A" }],
        signature: "",
      },
      {
        id: "2",
        source_info: { type: "web", name: "A2", citable: true },
        details: [{ link: "https://x", title: "A again" }],
        signature: "",
      },
    ];
    expect(dedupeCitations(cits)).toHaveLength(1);
  });

  it("dedupes file citations by Filename + Page", () => {
    const cits: Citation[] = [
      {
        id: "1",
        source_info: { type: "file", name: "report.pdf", citable: true },
        details: [{ Filename: "report.pdf", Page: 3 }],
        signature: "",
      },
      {
        id: "2",
        source_info: { type: "file", name: "report.pdf", citable: true },
        details: [{ Filename: "report.pdf", Page: 3 }],
        signature: "",
      },
      {
        id: "3",
        source_info: { type: "file", name: "report.pdf", citable: true },
        details: [{ Filename: "report.pdf", Page: 5 }],
        signature: "",
      },
    ];
    expect(dedupeCitations(cits)).toHaveLength(2);
  });
});

describe("buildAllCitations", () => {
  it("merges all three sources and dedupes", async () => {
    const w = widget();
    const cited = new Map([["u-1", { widget: w, inputArgs: { p: 1 } }]]);
    const mcp: McpCitation[] = [{ id: "m-1", type: "web", url: "https://x", title: "X" }];
    const intermediate: Citation[] = [
      {
        id: "i-1",
        source_info: { type: "web", name: "X", citable: true },
        details: [{ link: "https://x", title: "X" }],
        signature: "",
      },
    ];
    const out = await buildAllCitations(cited, mcp, intermediate);
    // 1 widget + 1 web (mcp web + intermediate web both link to https://x → dedup keeps first)
    expect(out).toHaveLength(2);
  });

  it("preserves order: intermediate → widget → mcp", async () => {
    const w = widget({ uuid: "u-w" });
    const cited = new Map([["u-w", { widget: w, inputArgs: {} }]]);
    const intermediate: Citation[] = [
      {
        id: "i-1",
        source_info: { type: "web", name: "I", citable: true },
        details: [{ link: "https://i", title: "I" }],
        signature: "",
      },
    ];
    const mcp: McpCitation[] = [{ id: "m-1", type: "web", url: "https://m", title: "M" }];
    const out = await buildAllCitations(cited, mcp, intermediate);
    expect(out[0].source_info.name).toBe("I");
    expect(out[2].source_info.name).toBe("M");
  });

  it("returns empty array when nothing is provided", async () => {
    expect(await buildAllCitations(new Map(), [], [])).toEqual([]);
  });
});

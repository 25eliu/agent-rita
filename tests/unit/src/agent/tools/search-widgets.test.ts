import { describe, it, expect } from "bun:test";
import { makeSearchWidgetsTool, searchWidgetsSchema } from "../../../../../src/agent/tools/search-widgets";
import type { TieredWidget, WidgetTier } from "../../../../../src/widgets/tiers";
import type { Widget } from "../../../../../src/protocol/types";

function w(overrides: Partial<Widget> = {}): Widget {
  return {
    uuid: "u-1",
    origin: "openbb",
    widget_id: "wid-1",
    name: "Sample",
    description: "",
    params: [],
    ...overrides,
  };
}

function t(widget: Widget, tier: WidgetTier = "extra"): TieredWidget {
  return { widget, tier };
}

interface SearchResult {
  uuid?: string;
  widget_id?: string;
  name: string;
  kind: "data" | "note" | "display";
  location: "added_to_context" | "on_dashboard" | "connected";
  params?: string[];
}

interface SearchOutput {
  matches: SearchResult[];
  total: number;
}

describe("searchWidgetsSchema", () => {
  it("requires query as a string", () => {
    expect(searchWidgetsSchema.parse({ query: "tech" })).toEqual({ query: "tech" });
    expect(() => searchWidgetsSchema.parse({})).toThrow();
  });
});

describe("makeSearchWidgetsTool — kind classification", () => {
  it("classifies rich_note widgets as note", async () => {
    const tool = makeSearchWidgetsTool([t(w({ widget_id: "rich_note_a", name: "Memo" }))]);
    const out = (await tool.execute!({ query: "memo" }, {} as never)) as SearchOutput;
    expect(out.matches[0].kind).toBe("note");
  });

  it("classifies copilot_table / iframe / youtube prefixes as display", async () => {
    const tool = makeSearchWidgetsTool([
      t(w({ widget_id: "copilot_table_x", name: "T" })),
      t(w({ widget_id: "iframe_x", name: "I" })),
      t(w({ widget_id: "youtube_x", name: "Y" })),
    ]);
    const out = (await tool.execute!({ query: "t i y" }, {} as never)) as SearchOutput;
    for (const m of out.matches) expect(m.kind).toBe("display");
  });

  it("classifies everything else as data", async () => {
    const tool = makeSearchWidgetsTool([t(w({ widget_id: "price", name: "Price" }))]);
    const out = (await tool.execute!({ query: "price" }, {} as never)) as SearchOutput;
    expect(out.matches[0].kind).toBe("data");
  });
});

describe("makeSearchWidgetsTool — result shape", () => {
  it("caps results at 100 and returns total separately", async () => {
    const widgets = Array.from({ length: 125 }, (_, i) =>
      t(w({ uuid: `u-${i}`, name: `Apple ${i}`, widget_id: `apple_${i}` })),
    );
    const tool = makeSearchWidgetsTool(widgets);
    const out = (await tool.execute!({ query: "apple" }, {} as never)) as SearchOutput;
    expect(out.matches.length).toBe(100);
    expect(out.total).toBe(125);
    expect(out.matches[0].widget_id).toBe("apple_0");
  });

  it("does not treat exact widget_id queries as canonical lookups", async () => {
    const tool = makeSearchWidgetsTool([
      t(w({
        uuid: "fred-series",
        origin: "Open Data Platform",
        widget_id: "economy_fred_series_fred_obb",
        name: "Fred Series",
        description: "Get data by series ID from FRED.",
      })),
      t(w({
        uuid: "fred-search",
        origin: "Open Data Platform",
        widget_id: "economy_fred_search_fred_obb",
        name: "Fred Search",
        description: "Search for FRED series IDs.",
      })),
    ]);

    const out = (await tool.execute!(
      { query: "economy_fred_series_fred_obb" },
      {} as never,
    )) as SearchOutput;

    expect(out.total).toBe(2);
    expect(out.matches.map((m) => m.widget_id)).toEqual([
      "economy_fred_series_fred_obb",
      "economy_fred_search_fred_obb",
    ]);
  });

  it("returns matches for rediscovery-style searches instead of blocking", async () => {
    const tool = makeSearchWidgetsTool([
      t(w({
        uuid: "bls-series",
        origin: "Open Data Platform",
        widget_id: "economy_survey_bls_series_bls_obb",
        name: "BLS Series",
        description: "Get BLS time series data.",
      })),
      t(w({
        uuid: "bls-search",
        origin: "Open Data Platform",
        widget_id: "economy_survey_bls_search_bls_obb",
        name: "BLS Search",
        description: "Search BLS surveys to identify BLS series IDs.",
      })),
    ]);

    const rediscovery = (await tool.execute!(
      { query: "economy_survey_bls_series_bls_obb" },
      {} as never,
    )) as SearchOutput & { blocked?: boolean };
    expect(rediscovery.blocked).toBeUndefined();
    expect(rediscovery.total).toBe(2);
    expect(rediscovery.matches.map((m) => m.widget_id).sort()).toEqual([
      "economy_survey_bls_search_bls_obb",
      "economy_survey_bls_series_bls_obb",
    ]);

    const lookup = (await tool.execute!(
      { query: "BLS Search" },
      {} as never,
    )) as SearchOutput;
    expect(lookup.total).toBe(2);
    expect(lookup.matches[0].widget_id).toBe("economy_survey_bls_search_bls_obb");
  });

  it("empty query lists primary first, then secondary, then extra", async () => {
    const widgets = [
      t(w({ uuid: "u-c", name: "Charlie", widget_id: "charlie" }), "extra"),
      t(w({ uuid: "u-a", name: "Alpha", widget_id: "alpha" }), "extra"),
      t(w({ uuid: "u-s", name: "Sigma", widget_id: "sigma" }), "secondary"),
      t(w({ uuid: "u-p", name: "Pi", widget_id: "pi" }), "primary"),
    ];
    const tool = makeSearchWidgetsTool(widgets);
    const out = (await tool.execute!({ query: "" }, {} as never)) as SearchOutput;
    expect(out.total).toBe(4);
    expect(out.matches.map((m) => m.name)).toEqual(["Pi", "Sigma", "Alpha", "Charlie"]);
    expect(out.matches.map((m) => m.location)).toEqual([
      "added_to_context",
      "on_dashboard",
      "connected",
      "connected",
    ]);
  });

  it("renders param strings with REQUIRED placeholder for missing values", async () => {
    const tool = makeSearchWidgetsTool([
      t(w({
        params: [
          { name: "ticker", type: "string", description: "" },
          { name: "limit", type: "number", description: "", current_value: 10 },
        ],
      })),
    ]);
    const out = (await tool.execute!({ query: "Sample" }, {} as never)) as SearchOutput;
    expect(out.matches[0].params).toEqual(["ticker:string=REQUIRED", "limit:number=10"]);
  });

  it("omits params field when widget has no params", async () => {
    const tool = makeSearchWidgetsTool([t(w())]);
    const out = (await tool.execute!({ query: "Sample" }, {} as never)) as SearchOutput;
    expect(out.matches[0].params).toBeUndefined();
  });

  it("translates tier to plain-language location field", async () => {
    const tool = makeSearchWidgetsTool([
      t(w({ uuid: "p", name: "P thing" }), "primary"),
      t(w({ uuid: "s", name: "S thing" }), "secondary"),
      t(w({ uuid: "e", name: "E thing" }), "extra"),
    ]);
    const out = (await tool.execute!({ query: "thing" }, {} as never)) as SearchOutput;
    const byUuid = Object.fromEntries(out.matches.map((m) => [m.name, m.location]));
    expect(byUuid["P thing"]).toBe("added_to_context");
    expect(byUuid["S thing"]).toBe("on_dashboard");
    expect(byUuid["E thing"]).toBe("connected");
  });
});

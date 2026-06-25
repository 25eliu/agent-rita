import { describe, it, expect } from "bun:test";
import {
  applyParamOverrides,
  getSqlSchema,
  getSqlWidgets,
  getAllWidgets,
  getTieredWidgets,
  searchWidgets,
  type TieredWidget,
  type WidgetTier,
} from "../../../../src/widgets/tiers";
import type { Widget, QueryRequest, SnowflakeSchema } from "../../../../src/protocol/types";

function tier(widget: Widget, t: WidgetTier): TieredWidget {
  return { widget, tier: t };
}

function w(overrides: Partial<Widget> = {}): Widget {
  return {
    uuid: "u-1",
    origin: "openbb",
    widget_id: "wid",
    name: "Sample widget",
    description: "Sample description",
    params: [],
    ...overrides,
  };
}

describe("applyParamOverrides", () => {
  it("replaces current_value on matching param names", () => {
    const widget = w({
      params: [
        { name: "symbol", type: "string", description: "", current_value: "AAPL" },
        { name: "limit", type: "number", description: "", current_value: 10 },
      ],
    });
    const result = applyParamOverrides(widget, { symbol: "NVDA" });
    expect(result.params[0].current_value).toBe("NVDA");
    expect(result.params[1].current_value).toBe(10);
  });

  it("preserves non-overridden params untouched", () => {
    const widget = w({
      params: [{ name: "symbol", type: "string", description: "", current_value: "AAPL" }],
    });
    const result = applyParamOverrides(widget, {});
    expect(result.params[0]).toEqual(widget.params[0]);
  });

  it("ignores override keys that don't correspond to any param", () => {
    const widget = w({
      params: [{ name: "symbol", type: "string", description: "" }],
    });
    const result = applyParamOverrides(widget, { unknown: "x" });
    expect(result.params).toHaveLength(1);
    expect(result.params[0].name).toBe("symbol");
  });

  it("does not mutate the source widget", () => {
    const widget = w({
      params: [{ name: "p", type: "string", description: "", current_value: "old" }],
    });
    const result = applyParamOverrides(widget, { p: "new" });
    expect(widget.params[0].current_value).toBe("old");
    expect(result.params[0].current_value).toBe("new");
  });
});

describe("getSqlSchema", () => {
  const validSchema: SnowflakeSchema = {
    tableName: "PRICES",
    database: "DB",
    schema: "SCH",
    columns: [
      { name: "symbol", type: "VARCHAR" },
      { name: "close", type: "FLOAT" },
    ],
  };

  it("returns the schema object when shape is valid", () => {
    const widget = w({ metadata: { schema: validSchema } });
    expect(getSqlSchema(widget)).toEqual(validSchema);
  });

  it("returns null when metadata.schema is missing", () => {
    expect(getSqlSchema(w({ metadata: {} }))).toBeNull();
    expect(getSqlSchema(w())).toBeNull();
  });

  it("returns null when schema is an array", () => {
    expect(getSqlSchema(w({ metadata: { schema: [] } }))).toBeNull();
  });

  it("returns null when required string fields are missing or wrong type", () => {
    const base = { ...validSchema };
    expect(
      getSqlSchema(w({ metadata: { schema: { ...base, tableName: 1 } } })),
    ).toBeNull();
    expect(
      getSqlSchema(w({ metadata: { schema: { ...base, database: undefined } } })),
    ).toBeNull();
    expect(
      getSqlSchema(w({ metadata: { schema: { ...base, schema: 0 } } })),
    ).toBeNull();
  });

  it("returns null when columns is not an array of {name, type}", () => {
    const base = { ...validSchema };
    expect(
      getSqlSchema(w({ metadata: { schema: { ...base, columns: "not an array" } } })),
    ).toBeNull();
    expect(
      getSqlSchema(w({ metadata: { schema: { ...base, columns: [{ name: "x" }] } } })),
    ).toBeNull();
    expect(
      getSqlSchema(w({ metadata: { schema: { ...base, columns: [null] } } })),
    ).toBeNull();
  });
});

describe("getSqlWidgets", () => {
  it("keeps only widgets with valid SnowflakeSchema metadata", () => {
    const a = w({
      uuid: "a",
      metadata: {
        schema: {
          tableName: "T",
          database: "D",
          schema: "S",
          columns: [{ name: "c", type: "VARCHAR" }],
        },
      },
    });
    const b = w({ uuid: "b" });
    const out = getSqlWidgets([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].widget.uuid).toBe("a");
    expect(out[0].schema.tableName).toBe("T");
  });
});

describe("getAllWidgets", () => {
  it("flattens primary + secondary + extra in order", () => {
    const req: QueryRequest = {
      messages: [],
      widgets: {
        primary: [w({ uuid: "p1" })],
        secondary: [w({ uuid: "s1" })],
        extra: [w({ uuid: "e1" })],
      },
    };
    const all = getAllWidgets(req);
    expect(all.map((x) => x.uuid)).toEqual(["p1", "s1", "e1"]);
  });

  it("fills uuid from widget_id when uuid is missing (catalog widget)", () => {
    const req: QueryRequest = {
      messages: [],
      widgets: { primary: [{ ...w({ uuid: undefined }), widget_id: "fallback-id" }] },
    };
    const all = getAllWidgets(req);
    expect(all[0].uuid).toBe("fallback-id");
  });

  it("returns empty list when no widgets are provided", () => {
    expect(getAllWidgets({ messages: [] })).toEqual([]);
  });
});

describe("getTieredWidgets", () => {
  it("tags each widget with its source tier", () => {
    const req: QueryRequest = {
      messages: [],
      widgets: {
        primary: [w({ uuid: "p1" })],
        secondary: [w({ uuid: "s1" })],
        extra: [w({ uuid: "e1" })],
      },
    };
    const out = getTieredWidgets(req);
    expect(out.map((t) => [t.widget.uuid, t.tier])).toEqual([
      ["p1", "primary"],
      ["s1", "secondary"],
      ["e1", "extra"],
    ]);
  });

  it("defaults uuid to widget_id for catalog widgets that arrive without one", () => {
    const req: QueryRequest = {
      messages: [],
      widgets: { extra: [w({ uuid: undefined, widget_id: "financial_statements" })] },
    };
    const out = getTieredWidgets(req);
    expect(out[0].widget.uuid).toBe("financial_statements");
  });

  it("leaves a placed widget's instance uuid untouched", () => {
    const req: QueryRequest = {
      messages: [],
      widgets: { secondary: [w({ uuid: "instance-123", widget_id: "financial_statements" })] },
    };
    const out = getTieredWidgets(req);
    expect(out[0].widget.uuid).toBe("instance-123");
  });
});

describe("searchWidgets", () => {
  const tiered: TieredWidget[] = [
    tier(w({ uuid: "1", name: "AAPL price", description: "Apple stock price", category: "equity" }), "extra"),
    tier(w({ uuid: "2", name: "NVDA earnings", description: "NVIDIA quarterly earnings" }), "extra"),
    tier(w({ uuid: "3", name: "MSFT news", description: "Microsoft news headlines" }), "extra"),
  ];

  it("returns widgets matching all whitespace-split query terms by hit count", () => {
    const out = searchWidgets(tiered, "Apple price");
    expect(out[0].widget.uuid).toBe("1");
  });

  it("ranks by hit count descending", () => {
    const out = searchWidgets(tiered, "earnings NVIDIA");
    expect(out[0].widget.uuid).toBe("2");
  });

  it("filters out widgets with zero hits", () => {
    const out = searchWidgets(tiered, "tesla");
    expect(out).toHaveLength(0);
  });

  it("empty query returns widgets ordered by tier (primary > secondary > extra), alphabetical within tier", () => {
    const mixed: TieredWidget[] = [
      tier(w({ uuid: "x1", name: "Zebra extra" }), "extra"),
      tier(w({ uuid: "x2", name: "Alpha extra" }), "extra"),
      tier(w({ uuid: "s1", name: "Zulu secondary" }), "secondary"),
      tier(w({ uuid: "p1", name: "Beta primary" }), "primary"),
      tier(w({ uuid: "p2", name: "Apple primary" }), "primary"),
    ];
    const out = searchWidgets(mixed, "");
    expect(out.map((t) => t.widget.uuid)).toEqual(["p2", "p1", "s1", "x2", "x1"]);
    const outBlank = searchWidgets(mixed, "   ");
    expect(outBlank.map((t) => t.widget.uuid)).toEqual(["p2", "p1", "s1", "x2", "x1"]);
  });

  it("ranked search uses tier as tiebreaker when hits are equal", () => {
    const mixed: TieredWidget[] = [
      tier(w({ uuid: "e1", name: "Apple data" }), "extra"),
      tier(w({ uuid: "p1", name: "Apple data" }), "primary"),
      tier(w({ uuid: "s1", name: "Apple data" }), "secondary"),
    ];
    const out = searchWidgets(mixed, "apple");
    expect(out.map((t) => t.widget.uuid)).toEqual(["p1", "s1", "e1"]);
  });

  it("matches on origin and category fields", () => {
    const out = searchWidgets(tiered, "equity");
    expect(out.map((t) => t.widget.uuid)).toContain("1");
  });

  it("does not search against widget identifiers", () => {
    const out = searchWidgets(
      [
        tier(w({
          uuid: "energy-widget",
          widget_id: "energy_vs_revenue",
          name: "Usage Widget",
          description: "",
          origin: "",
        }), "secondary"),
      ],
      "energy_vs_revenue",
    );
    expect(out).toEqual([]);
  });
});

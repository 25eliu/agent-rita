import { describe, it, expect } from "bun:test";
import {
  makeWidgetDataTool,
  widgetDataSchema,
} from "../../../../../src/agent/tools/widget-data";

describe("widgetDataSchema", () => {
  it("validates widgets array with widget_uuid and optional input_args", () => {
    const out = widgetDataSchema.parse({
      display_summary: "Loading selected widget data",
      widgets: [
        { widget_uuid: "u-1" },
        { widget_uuid: "u-2", input_args: { ticker: "NVDA" } },
      ],
    });
    expect(out.display_summary).toBe("Loading selected widget data");
    expect(out.widgets).toHaveLength(2);
    expect(out.widgets[1].input_args).toEqual({ ticker: "NVDA" });
  });

  it("requires widget_uuid on every entry", () => {
    expect(() => widgetDataSchema.parse({ widgets: [{}] })).toThrow();
  });

  it("rejects missing widgets array", () => {
    expect(() => widgetDataSchema.parse({})).toThrow();
  });
});

describe("makeWidgetDataTool", () => {
  it("returns a tool definition each call (factory)", () => {
    const a = makeWidgetDataTool();
    const b = makeWidgetDataTool();
    expect(a).not.toBe(b);
  });

  it("has no execute (round-trip tool — loop owns dispatch)", () => {
    const tool = makeWidgetDataTool();
    expect((tool as { execute?: unknown }).execute).toBeUndefined();
  });
});

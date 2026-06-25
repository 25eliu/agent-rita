import { describe, it, expect } from "bun:test";
import { runCreateApp } from "../../../../../src/agent/tools/app-artifact";
import type { AppArtifact, SSEEvent, Widget } from "../../../../../src/protocol/types";

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

interface LayoutInput {
  origin?: string;
  widget_id?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  state?: { params?: Record<string, unknown> };
}

function layout(o: LayoutInput = {}) {
  return {
    origin: o.origin ?? "openbb",
    widget_id: o.widget_id ?? "wid-1",
    x: o.x ?? 0,
    y: o.y ?? 0,
    w: o.w ?? 20,
    h: o.h ?? 8,
    ...(o.state ? { state: o.state } : {}),
  };
}

function firstArtifact(queue: SSEEvent[]): AppArtifact {
  return queue[0].data as unknown as AppArtifact;
}

describe("runCreateApp — happy path", () => {
  it("emits a single app artifact with resolved tabs and widget_refs", () => {
    const allWidgets = [
      w({ origin: "openbb", widget_id: "price", name: "Price", uuid: undefined }),
      w({ origin: "openbb", widget_id: "news", name: "News", uuid: "u-news" }),
    ];
    const artifactQueue: SSEEvent[] = [];
    const out = runCreateApp(
      {
        name: "My App",
        description: "desc",
        tabs: [
          {
            id: "overview",
            name: "Overview",
            layout: [
              layout({ widget_id: "price", x: 0, y: 0, w: 40, h: 10 }),
              layout({ widget_id: "news", x: 0, y: 10, w: 20, h: 8 }),
            ],
          },
        ],
      },
      { allWidgets, artifactQueue },
    );

    expect(out).toContain("My App");
    expect(artifactQueue).toHaveLength(1);
    expect(artifactQueue[0].event).toBe("copilotMessageArtifact");

    const artifact = firstArtifact(artifactQueue);
    expect(artifact.type).toBe("app");
    expect(artifact.name).toBe("My App");
    expect(artifact.widget_refs).toHaveLength(2);

    const overview = artifact.app.tabs["overview"];
    expect(overview.name).toBe("Overview");
    // i === widget_id, and x/y/w/h passed through verbatim
    expect(overview.layout[0]).toMatchObject({ i: "price", x: 0, y: 0, w: 40, h: 10 });
    expect(overview.layout[1]).toMatchObject({ i: "news", x: 0, y: 10, w: 20, h: 8 });

    // name/uuid resolved from the catalog, not from model input
    const newsRef = artifact.widget_refs.find((r) => r.widget_id === "news");
    expect(newsRef?.name).toBe("News");
    expect(newsRef?.uuid).toBe("u-news");
    // catalog widget without a uuid leaves uuid undefined
    const priceRef = artifact.widget_refs.find((r) => r.widget_id === "price");
    expect(priceRef?.uuid).toBeUndefined();
  });

  it("carries optional state.params through onto the layout item", () => {
    const allWidgets = [w({ widget_id: "price", name: "Price" })];
    const artifactQueue: SSEEvent[] = [];
    runCreateApp(
      {
        name: "A",
        description: "d",
        tabs: [
          {
            id: "t",
            name: "T",
            layout: [layout({ widget_id: "price", state: { params: { symbol: "AAPL" } } })],
          },
        ],
      },
      { allWidgets, artifactQueue },
    );
    const artifact = firstArtifact(artifactQueue);
    expect(artifact.app.tabs["t"].layout[0].state).toEqual({ params: { symbol: "AAPL" } });
  });

  it("assigns a fresh uuid per call", () => {
    const allWidgets = [w({ widget_id: "price" })];
    const artifactQueue: SSEEvent[] = [];
    const args = {
      name: "A",
      description: "d",
      tabs: [{ id: "t", name: "T", layout: [layout({ widget_id: "price" })] }],
    };
    runCreateApp(args, { allWidgets, artifactQueue });
    runCreateApp(args, { allWidgets, artifactQueue });
    const a = firstArtifact(artifactQueue);
    const b = artifactQueue[1].data as unknown as AppArtifact;
    expect(a.uuid).not.toBe(b.uuid);
  });
});

describe("runCreateApp — validation (no artifact emitted)", () => {
  it("rejects an unknown (origin, widget_id) and lists it", () => {
    const allWidgets = [w({ widget_id: "price" })];
    const artifactQueue: SSEEvent[] = [];
    const out = runCreateApp(
      {
        name: "A",
        description: "d",
        tabs: [{ id: "t", name: "T", layout: [layout({ widget_id: "does_not_exist" })] }],
      },
      { allWidgets, artifactQueue },
    );
    expect(out).toMatch(/Error/);
    expect(out).toContain("does_not_exist");
    expect(artifactQueue).toHaveLength(0);
  });

  it("rejects duplicate tab ids", () => {
    const allWidgets = [w({ widget_id: "price" })];
    const artifactQueue: SSEEvent[] = [];
    const out = runCreateApp(
      {
        name: "A",
        description: "d",
        tabs: [
          { id: "dup", name: "One", layout: [layout({ widget_id: "price" })] },
          { id: "dup", name: "Two", layout: [layout({ widget_id: "price" })] },
        ],
      },
      { allWidgets, artifactQueue },
    );
    expect(out).toMatch(/duplicate tab id/);
    expect(artifactQueue).toHaveLength(0);
  });

  it("rejects the same (origin, widget_id) twice within one tab", () => {
    const allWidgets = [w({ widget_id: "price" })];
    const artifactQueue: SSEEvent[] = [];
    const out = runCreateApp(
      {
        name: "A",
        description: "d",
        tabs: [
          {
            id: "t",
            name: "T",
            layout: [
              layout({ widget_id: "price", x: 0 }),
              layout({ widget_id: "price", x: 20 }),
            ],
          },
        ],
      },
      { allWidgets, artifactQueue },
    );
    expect(out).toMatch(/more than once/);
    expect(artifactQueue).toHaveLength(0);
  });
});

describe("runCreateApp — ticker group auto-detect", () => {
  const tickerParam = { name: "symbol", type: "string", description: "" };

  it("creates one Group 1 ticker group for >=2 widgets sharing a symbol param", () => {
    const allWidgets = [
      w({ widget_id: "price", name: "Price", params: [{ ...tickerParam, current_value: "AAPL" }] }),
      w({ widget_id: "news", name: "News", params: [tickerParam] }),
    ];
    const artifactQueue: SSEEvent[] = [];
    runCreateApp(
      {
        name: "A",
        description: "d",
        tabs: [
          {
            id: "t",
            name: "T",
            layout: [layout({ widget_id: "price" }), layout({ widget_id: "news", x: 20 })],
          },
        ],
      },
      { allWidgets, artifactQueue },
    );
    const groups = firstArtifact(artifactQueue).app.groups;
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      name: "Group 1",
      type: "ticker",
      widgetIds: ["price", "news"],
      defaultValue: "AAPL", // pulled from the param's current_value
    });
    expect(groups[0].paramName).toBeUndefined(); // ticker omits paramName
  });

  it("falls back to AAPL when no ticker value is set", () => {
    const allWidgets = [
      w({ widget_id: "a", params: [tickerParam] }),
      w({ widget_id: "b", params: [{ name: "ticker", type: "ticker", description: "" }] }),
    ];
    const artifactQueue: SSEEvent[] = [];
    runCreateApp(
      {
        name: "A",
        description: "d",
        tabs: [{ id: "t", name: "T", layout: [layout({ widget_id: "a" }), layout({ widget_id: "b", x: 20 })] }],
      },
      { allWidgets, artifactQueue },
    );
    expect(firstArtifact(artifactQueue).app.groups[0].defaultValue).toBe("AAPL");
  });

  it("emits no group when only one widget has a ticker param", () => {
    const allWidgets = [
      w({ widget_id: "price", params: [tickerParam] }),
      w({ widget_id: "news", params: [] }),
    ];
    const artifactQueue: SSEEvent[] = [];
    runCreateApp(
      {
        name: "A",
        description: "d",
        tabs: [{ id: "t", name: "T", layout: [layout({ widget_id: "price" }), layout({ widget_id: "news", x: 20 })] }],
      },
      { allWidgets, artifactQueue },
    );
    expect(firstArtifact(artifactQueue).app.groups).toHaveLength(0);
  });

  it("does NOT group a non-ticker shared param (left to runtime auto-sync)", () => {
    const limit = { name: "limit", type: "number", description: "" };
    const allWidgets = [
      w({ widget_id: "a", params: [limit] }),
      w({ widget_id: "b", params: [limit] }),
    ];
    const artifactQueue: SSEEvent[] = [];
    runCreateApp(
      {
        name: "A",
        description: "d",
        tabs: [{ id: "t", name: "T", layout: [layout({ widget_id: "a" }), layout({ widget_id: "b", x: 20 })] }],
      },
      { allWidgets, artifactQueue },
    );
    expect(firstArtifact(artifactQueue).app.groups).toHaveLength(0);
  });
});

describe("runCreateApp — widget_refs dedupe across tabs", () => {
  it("dedupes a widget reused across tabs into one ref", () => {
    const allWidgets = [w({ widget_id: "price", name: "Price" })];
    const artifactQueue: SSEEvent[] = [];
    runCreateApp(
      {
        name: "A",
        description: "d",
        tabs: [
          { id: "one", name: "One", layout: [layout({ widget_id: "price" })] },
          { id: "two", name: "Two", layout: [layout({ widget_id: "price" })] },
        ],
      },
      { allWidgets, artifactQueue },
    );
    const artifact = firstArtifact(artifactQueue);
    expect(artifact.widget_refs).toHaveLength(1);
    // but the widget still appears in both tab layouts
    expect(artifact.app.tabs["one"].layout).toHaveLength(1);
    expect(artifact.app.tabs["two"].layout).toHaveLength(1);
  });
});

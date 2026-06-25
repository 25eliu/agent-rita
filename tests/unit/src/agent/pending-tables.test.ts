import { describe, it, expect } from "bun:test";
import { setPendingTable } from "../../../../src/agent/pending-tables";

describe("setPendingTable", () => {
  it("inserts a new table without touching tablesShipped", () => {
    const pendingTables = new Map<string, Record<string, unknown>[]>();
    const tablesShipped = new Set<string>(["other"]);

    setPendingTable("prices", [{ symbol: "AAPL" }], pendingTables, tablesShipped);

    expect(pendingTables.get("prices")).toEqual([{ symbol: "AAPL" }]);
    expect(tablesShipped.has("other")).toBe(true);
    expect(tablesShipped.has("prices")).toBe(false);
  });

  it("invalidates tablesShipped when overwriting an existing key", () => {
    const pendingTables = new Map<string, Record<string, unknown>[]>([
      ["prices", [{ symbol: "AAPL" }]],
    ]);
    const tablesShipped = new Set<string>(["prices"]);

    setPendingTable("prices", [{ symbol: "MSFT" }], pendingTables, tablesShipped);

    expect(pendingTables.get("prices")).toEqual([{ symbol: "MSFT" }]);
    expect(tablesShipped.has("prices")).toBe(false);
  });

  it("does not invalidate other entries in tablesShipped on overwrite", () => {
    const pendingTables = new Map<string, Record<string, unknown>[]>([
      ["prices", [{ symbol: "AAPL" }]],
    ]);
    const tablesShipped = new Set<string>(["prices", "other"]);

    setPendingTable("prices", [{ symbol: "MSFT" }], pendingTables, tablesShipped);

    expect(tablesShipped.has("prices")).toBe(false);
    expect(tablesShipped.has("other")).toBe(true);
  });

  it("leaves tablesShipped untouched when overwriting a never-shipped key", () => {
    const pendingTables = new Map<string, Record<string, unknown>[]>([
      ["prices", [{ symbol: "AAPL" }]],
    ]);
    const tablesShipped = new Set<string>();

    setPendingTable("prices", [{ symbol: "MSFT" }], pendingTables, tablesShipped);

    expect(pendingTables.get("prices")).toEqual([{ symbol: "MSFT" }]);
    expect(tablesShipped.size).toBe(0);
  });
});

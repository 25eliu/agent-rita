import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { upstream } from "./upstream-mock";

const { resetTakoClientForTests } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/client"
);
const { takoContentsHandler } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/contents"
);

const savedToken = process.env.TAKO_API_TOKEN;

beforeEach(() => {
  delete process.env.TAKO_API_TOKEN;
  resetTakoClientForTests();
  upstream.reset();
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.TAKO_API_TOKEN;
  else process.env.TAKO_API_TOKEN = savedToken;
});

describe("takoContentsHandler", () => {
  it("hardwires json_records upstream and emits a sqlite_table", async () => {
    upstream.response = {
      content: [{ type: "text", text: "rows attached" }],
      structuredContent: {
        records: [{ year: 2024, revenue: 60.9 }],
        format: "json_records",
        total_rows: 1,
        truncated: false,
      },
      isError: false,
    };
    const res = await takoContentsHandler({
      url: "https://tako.com/card/nvda-revenue",
      max_rows: 100,
      table_name: "nvda_revenue",
    });
    expect(upstream.calls).toEqual([
      {
        name: "tako_contents",
        args: {
          url: "https://tako.com/card/nvda-revenue",
          content_format: "json_records",
          max_rows: 100,
        },
      },
    ]);
    const table = res.content.find((i) => i.text.includes('"sqlite_table"'));
    expect(table).toBeDefined();
    const parsed = JSON.parse(table!.text) as { name: string; rows: unknown[] };
    expect(parsed.name).toBe("nvda_revenue");
    expect(parsed.rows).toHaveLength(1);
  });

  it("derives the table name from the url when table_name is absent", async () => {
    upstream.response = {
      content: [{ type: "text", text: "rows attached" }],
      structuredContent: { records: [{ a: 1 }], truncated: false },
      isError: false,
    };
    const res = await takoContentsHandler({ url: "https://tako.com/card/nvda-revenue" });
    const table = res.content.find((i) => i.text.includes('"sqlite_table"'));
    const parsed = JSON.parse(table!.text) as { name: string };
    expect(parsed.name).toBe("tako_tako_nvda_revenue");
  });

  it("passes web page text through when upstream returns no records", async () => {
    upstream.response = {
      content: [{ type: "text", text: "full page text here" }],
      structuredContent: { data: "full page text here", truncated: false },
      isError: false,
    };
    const res = await takoContentsHandler({ url: "https://example.com/article" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toBe("full page text here");
  });

  it("returns hinted error text on isError (e.g. non-exportable card)", async () => {
    upstream.response = {
      content: [{ type: "text", text: "This card is not exportable" }],
      structuredContent: undefined,
      isError: true,
    };
    const res = await takoContentsHandler({ url: "https://tako.com/card/x" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toContain("not exportable");
  });

  it("surfaces persistent errors as text", async () => {
    upstream.errors.push(new Error("timeout"), new Error("timeout"));
    const res = await takoContentsHandler({ url: "https://tako.com/card/x" });
    expect(res.content[0]?.text).toContain("Tako contents fetch failed");
  });
});

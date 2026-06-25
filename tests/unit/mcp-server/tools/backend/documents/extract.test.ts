import { describe, it, expect } from "bun:test";
import { extractDocument } from "../../../../../../mcp-server/src/tools/backend/documents/extract";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("extractDocument — text + markdown", () => {
  it("decodes utf-8 txt to a single page", async () => {
    const result = await extractDocument("txt", utf8("hello world\nhow are you"));
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text).toContain("hello world");
    expect(result.pages[0].page).toBeUndefined();
    expect(result.totalChars).toBe("hello world\nhow are you".length);
  });

  it("decodes md identically (we don't parse markdown — it stays as text)", async () => {
    const md = "# Header\n\n* item 1\n* item 2";
    const result = await extractDocument("md", utf8(md));
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text).toBe(md);
  });

  it("rejects unknown formats with a clear error", async () => {
    // @ts-expect-error — testing the runtime guard for unknown formats
    await expect(extractDocument("xls", new Uint8Array())).rejects.toThrow(
      /Unsupported document format/,
    );
  });
});

describe("extractDocument — html", () => {
  it("strips tags and returns body text", async () => {
    const html =
      "<html><head><title>Hi</title></head><body><p>Hello <b>world</b></p></body></html>";
    const result = await extractDocument("html", utf8(html));
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text).toContain("Hello world");
    expect(result.pages[0].text).not.toContain("<p>");
  });

  it("removes script and style nodes from extracted text", async () => {
    const html =
      "<html><body><script>alert(1)</script><style>.x{}</style><p>Visible</p></body></html>";
    const result = await extractDocument("html", utf8(html));
    expect(result.pages[0].text).toContain("Visible");
    expect(result.pages[0].text).not.toContain("alert(1)");
    expect(result.pages[0].text).not.toContain(".x{}");
  });
});

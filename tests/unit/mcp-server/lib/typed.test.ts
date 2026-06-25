import { describe, it, expect } from "bun:test";
import {
  textItem,
  artifactItem,
  webCitationItem,
  documentCitationItem,
  sqliteTableItem,
  errorItem,
  modelContextItem,
  sandboxMetaItem,
  sandboxMetaPayloadSchema,
} from "../../../../mcp-server/src/lib/typed";

describe("typed.ts — helpers", () => {
  it("textItem wraps content in a plain text item (no $rita_kind)", () => {
    const item = textItem("hello");
    expect(item.type).toBe("text");
    expect(item.text).toBe("hello");
    expect(JSON.parse(JSON.stringify({ rt: item.text })).rt).toBe("hello");
    // explicit: text is NOT JSON
    expect(() => JSON.parse(item.text)).toThrow();
  });

  it("artifactItem JSON-encodes the artifact under $rita_kind", () => {
    const a = { type: "table", uuid: "u", name: "n", description: "d", content: [] };
    const item = artifactItem(a);
    expect(JSON.parse(item.text)).toEqual({ $rita_kind: "artifact", artifact: a });
  });

  it("webCitationItem includes id only when supplied", () => {
    const without = JSON.parse(webCitationItem({ url: "https://x", title: "X" }).text);
    expect(without).toEqual({
      $rita_kind: "citation",
      citation: { type: "web", url: "https://x", title: "X" },
    });
    expect("id" in without.citation).toBe(false);

    const withId = JSON.parse(webCitationItem({ url: "https://x", title: "X", id: "fixed" }).text);
    expect(withId.citation.id).toBe("fixed");
  });

  it("documentCitationItem includes page and id only when supplied", () => {
    const minimal = JSON.parse(documentCitationItem({ uri: "doc://a", title: "A" }).text);
    expect(minimal.citation).toEqual({ type: "document", uri: "doc://a", title: "A" });
    expect("page" in minimal.citation).toBe(false);
    expect("id" in minimal.citation).toBe(false);

    const full = JSON.parse(
      documentCitationItem({ uri: "doc://a", title: "A", page: 4, id: "d-1" }).text,
    );
    expect(full.citation).toEqual({
      type: "document",
      uri: "doc://a",
      title: "A",
      page: 4,
      id: "d-1",
    });
  });

  it("sqliteTableItem encodes name + rows under $rita_kind", () => {
    const item = sqliteTableItem("Prices", [{ a: 1 }]);
    expect(JSON.parse(item.text)).toEqual({
      $rita_kind: "sqlite_table",
      name: "Prices",
      rows: [{ a: 1 }],
    });
  });

  it("errorItem defaults retryable to false", () => {
    const def = JSON.parse(errorItem({ code: "C", message: "m" }).text);
    expect(def).toEqual({ $rita_kind: "error", error: { code: "C", message: "m", retryable: false } });

    const ret = JSON.parse(errorItem({ code: "C", message: "m", retryable: true }).text);
    expect(ret.error.retryable).toBe(true);
  });

  it("modelContextItem encodes summary", () => {
    const item = modelContextItem("use this only");
    expect(JSON.parse(item.text)).toEqual({ $rita_kind: "model_context", summary: "use this only" });
  });

  it("sandboxMetaItem encodes sandbox_id under $rita_kind and parses via Zod", () => {
    const item = sandboxMetaItem("sb-abc-123");
    const parsed = JSON.parse(item.text);
    expect(parsed).toEqual({ $rita_kind: "sandbox_meta", sandbox_id: "sb-abc-123" });
    expect(sandboxMetaPayloadSchema.parse({ sandbox_id: parsed.sandbox_id })).toEqual({
      sandbox_id: "sb-abc-123",
    });
    expect(() => sandboxMetaPayloadSchema.parse({})).toThrow();
    expect(() => sandboxMetaPayloadSchema.parse({ sandbox_id: "" })).toThrow();
  });
});

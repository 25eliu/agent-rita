import { describe, it, expect } from "bun:test";
import { parseJsonResponse, truncate } from "../../../../src/lib/llm";

describe("parseJsonResponse", () => {
  it("parses bare JSON", () => {
    expect(parseJsonResponse('{"a":1}', { a: 0 })).toEqual({ a: 1 });
  });

  it("strips ```json fenced blocks before parsing", () => {
    expect(parseJsonResponse('```json\n{"a":2}\n```', { a: 0 })).toEqual({ a: 2 });
  });

  it("returns the fallback when JSON is malformed", () => {
    expect(parseJsonResponse("not json", { fallback: true })).toEqual({ fallback: true });
  });

  it("returns the fallback on empty string", () => {
    expect(parseJsonResponse("", { x: 1 })).toEqual({ x: 1 });
  });
});

describe("truncate", () => {
  it("returns the input unchanged when shorter than max", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  it("returns the input unchanged at exact max length", () => {
    expect(truncate("12345", 5)).toBe("12345");
  });

  it("appends an ellipsis when truncated", () => {
    expect(truncate("123456", 3)).toBe("123...");
  });
});

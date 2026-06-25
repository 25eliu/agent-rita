import { describe, it, expect, beforeEach, mock } from "bun:test";

let nextLlm: () => Promise<string> = async () => "default";

mock.module("../../../../../src/lib/llm", () => ({
  singleShotLlm: async () => nextLlm(),
  parseJsonResponse: <T>(raw: string, fallback: T): T => {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  truncate: (s: string, max: number) => (s.length > max ? s.slice(0, max) + "..." : s),
}));

const { runEnhancePrompt } = await import("../../../../../src/agent/tools/enhance-prompt");

beforeEach(() => {
  nextLlm = async () => "default";
});

describe("runEnhancePrompt", () => {
  it("returns the LLM-rewritten query verbatim", async () => {
    nextLlm = async () =>
      "Apple Q4 2024 total revenue in USD, including breakdown by segment.";
    const out = await runEnhancePrompt({
      reasoning: "missing year + entity",
      query: "How much did they make last quarter?",
    });
    expect(out).toBe(
      "Apple Q4 2024 total revenue in USD, including breakdown by segment.",
    );
  });

  it("propagates LLM errors to the caller", async () => {
    nextLlm = async () => {
      throw new Error("model timeout");
    };
    await expect(
      runEnhancePrompt({ reasoning: "vague", query: "foo" }),
    ).rejects.toThrow(/model timeout/);
  });
});

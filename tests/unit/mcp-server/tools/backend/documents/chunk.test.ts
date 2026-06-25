import { describe, it, expect } from "bun:test";
import { chunkDocument } from "../../../../../../mcp-server/src/tools/backend/documents/chunk";

const SHORT_PAGE = {
  text: "Hello world. This is a short doc. Only three sentences total.",
};

const LONG_PARA =
  "Sentence number one is here. Sentence number two follows it. Then comes the third sentence. " +
  "After that we have the fourth one. Number five lands now. The sixth sentence is here. " +
  "Number seven is short. Eight follows. Nine continues. Ten finally arrives. " +
  "Now the eleventh. Twelfth coming up. Lucky thirteen. Fourteen on the way. " +
  "Fifteen sentences in. Sixteen we go. Seventeen here. Eighteen now. Nineteen close. Twenty done.";

describe("chunkDocument — small inputs", () => {
  it("returns empty for empty pages", () => {
    expect(chunkDocument("d1", [])).toEqual([]);
    expect(chunkDocument("d1", [{ text: "" }])).toEqual([]);
    expect(chunkDocument("d1", [{ text: "   " }])).toEqual([]);
  });

  it("emits a single chunk when text fits under target token budget", () => {
    const out = chunkDocument("d1", [SHORT_PAGE]);
    expect(out).toHaveLength(1);
    expect(out[0].docId).toBe("d1");
    expect(out[0].index).toBe(0);
    expect(out[0].id).toBe("d1:0");
    expect(out[0].text).toContain("Hello world");
    expect(out[0].text).toContain("Only three sentences total");
    expect(out[0].tokens).toBeGreaterThan(0);
  });

  it("preserves page metadata when supplied", () => {
    const out = chunkDocument("d1", [
      { page: 1, text: "Page one content here." },
      { page: 2, text: "Page two content here." },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].page).toBe(1);
    expect(out[1].page).toBe(2);
  });
});

describe("chunkDocument — boundary behavior", () => {
  it("splits when sentences would overflow target tokens", () => {
    const out = chunkDocument("d1", [{ text: LONG_PARA }], {
      targetTokens: 30,
      overlapTokens: 0,
      maxTokens: 60,
    });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.tokens).toBeLessThanOrEqual(60);
      expect(c.text.length).toBeGreaterThan(0);
    }
  });

  it("creates indexes contiguously across pages", () => {
    const out = chunkDocument("d1", [
      { page: 1, text: LONG_PARA },
      { page: 2, text: LONG_PARA },
    ], { targetTokens: 30, overlapTokens: 0, maxTokens: 60 });
    for (let i = 0; i < out.length; i++) {
      expect(out[i].index).toBe(i);
      expect(out[i].id).toBe(`d1:${i}`);
    }
  });

  it("emits oversize sentence as its own chunk rather than dropping", () => {
    const giant = "GiantSentenceNoBreaks ".repeat(120).trim() + ".";
    const out = chunkDocument("d1", [{ text: giant }], {
      targetTokens: 30,
      overlapTokens: 0,
      maxTokens: 50,
    });
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.some((c) => c.tokens > 50)).toBe(true);
  });

  it("respects overlap when emitting subsequent chunks", () => {
    const out = chunkDocument("d1", [{ text: LONG_PARA }], {
      targetTokens: 30,
      overlapTokens: 15,
      maxTokens: 60,
    });
    expect(out.length).toBeGreaterThan(1);
    // Some sentence from the tail of chunk[0] should appear inside chunk[1].
    const lastTail = out[0].text.split(/\.\s+/).slice(-2)[0];
    if (lastTail) expect(out[1].text).toContain(lastTail);
  });
});

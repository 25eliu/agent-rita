/**
 * Tier 1 — the streaming text sink (text-sink.ts).
 *
 * The load-bearing property: for ANY delta splitting of an input, the
 * concatenation of every pushDelta() chunk plus flushTail() equals
 * stripPlaceholderTags() of the whole input. This is what guarantees a
 * placeholder tag can never leak just because it straddled a delta boundary —
 * the streaming strip and the bulk strip are provably the same.
 */

import { describe, it, expect } from "bun:test";
import { makeTextSink, type TextSinkContext } from "../../../../src/agent/text-sink";
import { stripPlaceholderTags } from "../../../../src/protocol/events";
import type { SSEEvent } from "../../../../src/protocol/types";

function inertContext(deferred: SSEEvent[] = []): TextSinkContext {
  return { deferredAnswerArtifactEvents: deferred, onArtifactEmitted: () => {} };
}

function chunkText(events: SSEEvent[]): string {
  return events
    .filter((e) => e.event === "copilotMessageChunk")
    .map((e) => (e.data as { delta: string }).delta)
    .join("");
}

function runSplit(deltas: string[], deferred: SSEEvent[] = []): SSEEvent[] {
  const sink = makeTextSink(inertContext(deferred));
  const events: SSEEvent[] = [];
  for (const d of deltas) events.push(...sink.pushDelta(d));
  events.push(...sink.flushTail());
  return events;
}

// A bounded but adversarial set of delta splittings: the whole string, every
// single-cut 2-way split, char-by-char (every boundary cut at once), and a
// strided sample of 3-way splits. Together these straddle every pattern across
// at least one boundary.
function* enumerateSplits(s: string): Generator<string[]> {
  yield [s];
  yield [...s];
  for (let i = 1; i < s.length; i++) yield [s.slice(0, i), s.slice(i)];
  for (let i = 1; i < s.length; i++) {
    for (let j = i + 1; j < s.length; j += 5) {
      yield [s.slice(0, i), s.slice(i, j), s.slice(j)];
    }
  }
}

// Inputs WITHOUT a real `<suggestions>` block — the strict invariant applies.
const STRICT_INPUTS = [
  // the streaming-leak.test.ts inputs
  "Result: <artifact_id:abcd-1234>see chart</artifact_id> done.",
  'A <copilot_table:7>foo B <rita_artifact id="x">bar</rita_artifact> end',
  "The artifact has rendered. Reference its uuid for follow-up.",
  '**Trend**\n\n<img src="data:image/png;base64,AAAA" alt="Trend" />\n\nDone.',
  // pipe markers (paired + lone)
  "<|start_artifact_id|>artifact-1<|end_artifact_id|>answer",
  "answer<|start_citation_id|>citation-1<|end_citation_id|>",
  "before<|start_artifact|>x<|end_artifact|>mid<|start_citation|>y<|end_citation|>after",
  "lone <|end_artifact|> marker then <|start_artifact|> with no closing end",
  // base64 markdown image
  "![Chart](data:image/png;base64,iVBORw0KGgo= )answer",
  "lead ![alt](http://example.com/a.png) keeps normal links",
  // bare angle brackets that are NOT tags
  "P/E < 15 is cheap; 5 < 10 always holds; compare a<b results.",
  "text with <notatag> and </div> left intact and > greater signs",
  // dangling suggestion fragments (no `<`)
  "Compare safety trends with workforcesuggestion>",
  "Create a detailed ESG performancesuggestionsuggestions>",
  // mermaid fence (no artifact in context → passes through unchanged)
  "diagram:\n```mermaid\nflowchart TD\n  A-->B\n```\ndone",
  // a mix
  "mix <chart foo=1> then <artifact bar> plus <citation_id:9>cite</citation_id> end",
];

describe("text-sink — strip invariant under every delta split", () => {
  for (const input of STRICT_INPUTS) {
    it(`equals stripPlaceholderTags for: ${JSON.stringify(input.slice(0, 40))}…`, () => {
      const expected = stripPlaceholderTags(input);
      for (const deltas of enumerateSplits(input)) {
        const got = chunkText(runSplit(deltas));
        expect(got).toBe(expected);
      }
    });
  }

  it("never emits a known placeholder tag regardless of split", () => {
    for (const input of STRICT_INPUTS) {
      for (const deltas of enumerateSplits(input)) {
        const got = chunkText(runSplit(deltas));
        expect(got).not.toMatch(/<\/?artifact_id\b/i);
        expect(got).not.toMatch(/<\/?copilot_table\b/i);
        expect(got).not.toMatch(/<\/?rita_artifact\b/i);
        expect(got).not.toMatch(/<img\b/i);
        expect(got).not.toMatch(/data:image\//i);
        expect(got).not.toMatch(/<\|(?:start|end)_/i);
      }
    }
  });
});

describe("text-sink — bounded hold prevents deadlock", () => {
  it("emits an unterminated tag verbatim once it exceeds the cap", () => {
    const longRun = "x".repeat(70_000);
    const events = runSplit(["<artifact ", longRun]);
    const text = chunkText(events);
    expect(text.length).toBeGreaterThanOrEqual(70_000);
    expect(text).toContain(longRun);
    // The dangling `<artifact ` (no `>`) is real prose now, kept verbatim.
    expect(text).toContain("<artifact ");
  });

  it("emits an unterminated paired-pipe interior once it exceeds the cap", () => {
    const longRun = "y".repeat(70_000);
    const text = chunkText(runSplit([`<|start_artifact|>${longRun}`]));
    expect(text).toContain(longRun);
  });
});

describe("text-sink — <suggestions> held then extracted, never leaked as prose", () => {
  const input =
    "Answer body here\n\n<suggestions>\n<suggestion>Show revenue</suggestion>\n<suggestion>Show emissions</suggestion>\n</suggestions>";

  it("streams only the prose before the block, even split char-by-char", () => {
    for (const deltas of [[input], [...input], [input.slice(0, 20), input.slice(20)]]) {
      const sink = makeTextSink(inertContext());
      const events: SSEEvent[] = [];
      for (const d of deltas) events.push(...sink.pushDelta(d));
      events.push(...sink.flushTail());
      const text = chunkText(events);
      expect(text).toContain("Answer body here");
      expect(text).not.toContain("<suggestions");
      expect(text).not.toContain("Show revenue"); // suggestion body never leaks as prose
      const { suggestions, cleanTail } = sink.takeSuggestions();
      expect(suggestions).toEqual(["Show revenue", "Show emissions"]);
      expect(cleanTail).toBe("");
    }
  });

  it("triggers on plural <suggestions>, not a stray singular <suggestion> in prose", () => {
    const sink = makeTextSink(inertContext());
    const events = [...sink.pushDelta("See the <suggestion> word in prose."), ...sink.flushTail()];
    // No real block — the singular tag is a placeholder, stripped, and no
    // suggestions are captured.
    expect(sink.takeSuggestions().suggestions).toEqual([]);
    expect(chunkText(events)).not.toContain("<suggestion>");
  });
});

describe("text-sink — answer-artifact weave", () => {
  function artifactEvent(): SSEEvent {
    return { event: "copilotMessageArtifact", data: { type: "table", name: "Prices" } };
  }

  it("weaves the artifact at the first paragraph break (single delta)", () => {
    const deferred = [artifactEvent()];
    let artifactCount = 0;
    const sink = makeTextSink({
      deferredAnswerArtifactEvents: deferred,
      onArtifactEmitted: () => artifactCount++,
    });
    const events = [
      ...sink.pushDelta("Here is the prices table.\n\nTop close is 200."),
      ...sink.flushTail(),
    ];
    const lead = events.findIndex(
      (e) => e.event === "copilotMessageChunk" && (e.data as { delta: string }).delta === "Here is the prices table.\n\n",
    );
    const art = events.findIndex((e) => e.event === "copilotMessageArtifact");
    const follow = events.findIndex(
      (e) => e.event === "copilotMessageChunk" && (e.data as { delta: string }).delta === "Top close is 200.",
    );
    expect(lead).toBeGreaterThanOrEqual(0);
    expect(art).toBeGreaterThan(lead);
    expect(follow).toBeGreaterThan(art);
    expect(artifactCount).toBe(1);
    expect(deferred.length).toBe(0); // drained
  });

  it("places the artifact first for a short no-paragraph answer (fallback)", () => {
    const deferred = [artifactEvent()];
    const sink = makeTextSink({ deferredAnswerArtifactEvents: deferred, onArtifactEmitted: () => {} });
    const events = [...sink.pushDelta("Top close is 200; table attached."), ...sink.flushTail()];
    const art = events.findIndex((e) => e.event === "copilotMessageArtifact");
    const text = events.findIndex(
      (e) => e.event === "copilotMessageChunk" && (e.data as { delta: string }).delta.includes("Top close is 200"),
    );
    expect(art).toBeGreaterThanOrEqual(0);
    expect(text).toBeGreaterThan(art); // artifact before the short answer
  });

  it("strips a rendered mermaid fence when an answer artifact is present", () => {
    const deferred = [artifactEvent()];
    const sink = makeTextSink({ deferredAnswerArtifactEvents: deferred, onArtifactEmitted: () => {} });
    const input = "See the flow below.\n\n```mermaid\nflowchart TD\n  A-->B\n```\n\nThat is the design.";
    const events = [...sink.pushDelta(input), ...sink.flushTail()];
    const text = chunkText(events);
    expect(text).not.toContain("flowchart TD");
    expect(text).not.toContain("```mermaid");
    expect(text).toContain("See the flow below.");
    expect(text).toContain("That is the design.");
    expect(events.some((e) => e.event === "copilotMessageArtifact")).toBe(true);
  });
});

describe("text-sink — textEmitted flag", () => {
  it("is false until non-empty text is emitted", () => {
    const sink = makeTextSink(inertContext());
    expect(sink.textEmitted).toBe(false);
    sink.pushDelta("hello");
    expect(sink.textEmitted).toBe(true);
  });

  it("stays false for a pure placeholder-only input", () => {
    const sink = makeTextSink(inertContext());
    sink.pushDelta("<|start_artifact_id|>only<|end_artifact_id|>");
    sink.flushTail();
    expect(sink.textEmitted).toBe(false);
  });
});

// Deterministic LCG — reproducible across runs, no Math.random (which would
// make a failure unreproducible and the suite flaky).
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Vocab the fuzzer assembles inputs from. `enumerateSplits` already covers split
// POSITIONS exhaustively; this widens the INPUT VOCABULARY so divergence between
// the bulk regexes (events.ts) and the sink's hand-coded incremental detectors
// (couldBeTagStart / pairedPipeHoldStart / dataImageHoldStart / mermaidHoldStart /
// trailingSuggestionRunStart) is caught automatically — not only for the fixed
// STRICT_INPUTS list. A real plural `<suggestions …>` open tag is intentionally
// absent: the sink HOLDS that block out of the chunk stream (surfaced via
// takeSuggestions), so the strict concat===strip invariant does not apply to it
// (covered separately above). Every other strippable pattern is fair game.
const FUZZ_TOKENS: string[] = (() => {
  const names = [
    "artifact_id", "artifact", "copilot_table", "rita_artifact",
    "citation_id", "citation", "chart",
  ];
  const tags: string[] = [];
  for (const n of names) tags.push(`<${n}>`, `</${n}>`, `<${n} id="x">`, `<${n}:7>`);
  return [
    ...tags,
    '<img src="data:image/png;base64,AAAA" alt="x" />',
    "<|start_artifact_id|>z<|end_artifact_id|>",
    "<|start_citation|>c<|end_citation|>",
    "<|start_artifact|>", // lone start (bulk strips via the standalone pipe pattern)
    "<|end_citation|>", // lone end
    "![alt](data:image/png;base64,AAAA)",
    "![alt](http://example.com/a.png)", // normal link — must NOT be stripped
    "```mermaid\nflowchart TD\n  A-->B\n```",
    "<notatag>", "</div>", // non-placeholder tags — must pass through intact
    "a<b", "P/E < 15", "5 < 10 ", "x > y",
    "The revenue ", "see chart ", "compare ", "trend. ", "done.",
    "\n\n", "\n", " ", "<", ">", "< ",
    "suggestion>", "workforcesuggestion>", // dangling-suggestion fragments (no `<`)
  ];
})();

describe("text-sink — seeded vocab fuzz keeps the strip invariant", () => {
  it("equals stripPlaceholderTags for randomized inputs under every split", () => {
    const rng = makeRng(0xc0ffee);
    const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
    const ITERATIONS = 150;
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const tokenCount = 1 + Math.floor(rng() * 6);
      let input = "";
      for (let t = 0; t < tokenCount; t++) input += pick(FUZZ_TOKENS);
      // A real plural <suggestions …> can form by concatenation — excluded from
      // the strict invariant by design (the sink extracts it, not strips it).
      if (/<suggestions\b/i.test(input)) continue;
      const expected = stripPlaceholderTags(input);
      for (const deltas of enumerateSplits(input)) {
        const got = chunkText(runSplit(deltas));
        if (got !== expected) {
          throw new Error(
            `strip invariant broke for a fuzz input:\n  input=${JSON.stringify(input)}\n  deltas=${JSON.stringify(deltas)}\n  got=${JSON.stringify(got)}\n  expected=${JSON.stringify(expected)}`,
          );
        }
      }
    }
  });
});

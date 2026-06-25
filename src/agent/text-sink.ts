/**
 * Request-scoped streaming text sink.
 *
 * The agent loop consumes `result.fullStream` and forwards each `text-delta`
 * to this sink, which returns the `copilotMessageChunk` SSE events to emit
 * RIGHT NOW (plus any inline answer-artifact events woven at a paragraph
 * break). It is the SOLE sanitizer on the streaming path — nothing else strips
 * placeholder tags once text is flowing.
 *
 * It owns, behind one factory closure (no class — repo convention):
 *  - an incremental withhold-to-terminator tag-strip state machine,
 *  - the `<suggestions>` hold + extract,
 *  - the mermaid-fence hold,
 *  - paragraph tracking for the answer-artifact weave,
 *  - the `textEmitted` flag.
 *
 * Core invariant: for ANY delta splitting of an input, the concatenation of
 * every `pushDelta()` chunk plus `flushTail()` equals `stripPlaceholderTags`
 * of the whole input — modulo the extracted `<suggestions>` tail and the
 * bounded-hold cap. The strip itself is delegated to `stripPlaceholderTags`
 * (events.ts) so the streaming path and the bulk path can never diverge.
 */

import type { SSEEvent } from "../protocol/types";
import {
  PAIRED_PIPE_PLACEHOLDER_NAMES,
  PLACEHOLDER_TAG_NAMES,
  parseSuggestions,
  streamingMessageChunk,
  stripPlaceholderTags,
} from "../protocol/events";

export interface TextSinkContext {
  /**
   * The loop's request-scoped deferred answer-artifact queue. The sink weaves
   * these into the streamed text at a paragraph break (or via the
   * `splitForArtifactInsertion` fallback on flush) and drains them in place.
   */
  deferredAnswerArtifactEvents: SSEEvent[];
  /**
   * Called once per artifact the sink emits, so the loop can flip its
   * `answerArtifactEmitted` flag (drives the terminal-tool-stop guard).
   */
  onArtifactEmitted: () => void;
}

export interface TextSink {
  /** Feed a streamed text delta; returns the SSE events to emit now. */
  pushDelta(text: string): SSEEvent[];
  /** Flush held text + any un-woven artifacts. Call at stream end AND before every round-trip SSE. */
  flushTail(): SSEEvent[];
  /** Parse the held `<suggestions>` block (if any) at the final dispatch. */
  takeSuggestions(): { cleanTail: string; suggestions: string[] };
  /** True once any non-empty answer text has been emitted. */
  readonly textEmitted: boolean;
}

// `<name …>` placeholder tag names (events.ts) plus `img`, which the bulk strip
// also removes. Used to decide whether a still-open trailing `<…` run COULD
// become a stripped tag — so prose like "P/E < 15" streams immediately while
// "<artif" is withheld until its `>`.
const TAG_NAMES = [...PLACEHOLDER_TAG_NAMES, "img"];

// Cap on how long a single withheld region may grow before we give up and emit
// it verbatim. A "tag" / fence / paired-pipe this long is real prose, not a
// placeholder; the cap prevents an unterminated start token from swallowing the
// whole answer (the deadlock both review agents flagged).
const MAX_HOLD = 64 * 1024;

const SUGGESTIONS_OPEN = /<suggestions\b[^>]*>/i;
const MERMAID_FENCE_OPEN = /```(?:mermaid|mmd)\b/gi;
const TRAILING_FENCE_LANG = /```([a-z]*)$/i;
// Trailing prefix of the dangling-suggestion run `(?:suggestions?)+>`: zero or
// more full tokens then a PARTIAL prefix of "suggestions" (so "…workforcesugg"
// at a delta boundary is held until we learn whether a `>` follows). Partial
// alternatives are longest-first so the regex is greedy.
const SUGGESTION_PARTIALS = Array.from({ length: "suggestions".length }, (_, i) =>
  "suggestions".slice(0, "suggestions".length - i),
).join("|");
const TRAILING_SUGGESTION_PREFIX = new RegExp(
  `(?:suggestions?)*(?:${SUGGESTION_PARTIALS})?$`,
  "i",
);
const PARAGRAPH_BREAK = /\n{2,}/;
const CLOSED_MERMAID_FENCE = /```(?:mermaid|mmd)\s*\n[\s\S]*?\n```/gi;
const WORD_CHAR = /[a-z0-9_]/;

// Would a trailing, still-unterminated `<…` run match a placeholder tag if
// extended? `tail` begins at the last unmatched `<`.
function couldBeTagStart(tail: string): boolean {
  let s = tail.slice(1);
  if (s.startsWith("/")) s = s.slice(1);
  if (s.startsWith("|")) return true; // pipe marker `<|start_…|>` / `<|end_…|>`
  const lower = s.toLowerCase();
  for (const name of TAG_NAMES) {
    if (name.startsWith(lower)) return true; // still typing the name (covers "")
    if (lower.startsWith(name)) {
      // name complete — inside the `[^>]*` attribute run, but only if a word
      // boundary follows the name (mirrors the `\b` in the bulk pattern).
      const after = lower[name.length];
      if (after !== undefined && !WORD_CHAR.test(after)) return true;
    }
  }
  return false;
}

// Earliest `<|start_NAME|>` lacking a matching `<|end_NAME|>` after it. The
// bulk strip removes the WHOLE paired span (interior included), so we must hold
// from the start marker until its end arrives — otherwise the content between
// them would leak as visible text.
function pairedPipeHoldStart(buf: string): number {
  const startRe = new RegExp(
    `<\\|start_(${PAIRED_PIPE_PLACEHOLDER_NAMES.join("|")})\\|>`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(buf)) !== null) {
    const afterStart = m.index + m[0].length;
    const endRe = new RegExp(`<\\|end_${m[1]}\\|>`, "i");
    if (!endRe.test(buf.slice(afterStart))) return m.index;
  }
  return -1;
}

// `![alt](data:image/…)` — the bulk strip removes inline base64 images. Hold
// from the earliest `![` that is still a viable INCOMPLETE prefix of that
// pattern; a normal `![alt](http…)` link is not a prefix, so it is never held.
function dataImageHoldStart(buf: string): number {
  let idx = buf.indexOf("![");
  while (idx >= 0) {
    if (isIncompleteDataImage(buf.slice(idx))) return idx;
    idx = buf.indexOf("![", idx + 2);
  }
  if (buf.endsWith("!")) return buf.length - 1; // a lone trailing `!` could begin `![`
  return -1;
}

function isIncompleteDataImage(rest: string): boolean {
  let s = rest.slice(2); // after "!["
  const closeBracket = s.indexOf("]");
  if (closeBracket < 0) return true; // still in alt text — could become an image
  s = s.slice(closeBracket + 1);
  if (s.length === 0) return true; // "![alt]" — could continue with "("
  if (s[0] !== "(") return false; // "![alt]x" — not an image link
  s = s.slice(1);
  const prefix = "data:image/";
  if (s.length < prefix.length) return prefix.startsWith(s); // typing the scheme
  if (!s.startsWith(prefix)) return false; // "(http…" — not a data image
  return !s.includes(")"); // open until the closing ')'
}

// Earliest unclosed ```mermaid / ```mmd fence, plus a trailing ``` that could
// still become one. (The bulk path strips rendered mermaid code when an answer
// artifact is present; holding the fence whole lets the streaming path do the
// same instead of leaking the half a fence that straddles a delta boundary.)
function mermaidHoldStart(buf: string): number {
  MERMAID_FENCE_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MERMAID_FENCE_OPEN.exec(buf)) !== null) {
    const close = buf.indexOf("```", m.index + m[0].length);
    if (close < 0) return m.index; // unclosed fence
    MERMAID_FENCE_OPEN.lastIndex = close + 3;
  }
  const partial = TRAILING_FENCE_LANG.exec(buf);
  if (partial) {
    const lang = partial[1].toLowerCase();
    if (lang === "" || "mermaid".startsWith(lang) || "mmd".startsWith(lang)) {
      return partial.index;
    }
  }
  return -1;
}

function trailingSuggestionRunStart(buf: string): number {
  const m = TRAILING_SUGGESTION_PREFIX.exec(buf);
  if (!m || m[0].length === 0) return -1;
  return m.index;
}

// Index from which the buffer suffix is potentially part of an unterminated,
// strippable pattern. Everything before it is safe to emit (after a bulk
// strip); the suffix is withheld until its terminator (or the cap / flush).
function computeHoldStart(buf: string): number {
  let hold = buf.length;
  const consider = (i: number): void => {
    if (i >= 0 && i < hold) hold = i;
  };

  consider(pairedPipeHoldStart(buf));
  const lt = buf.lastIndexOf("<");
  if (lt > buf.lastIndexOf(">") && couldBeTagStart(buf.slice(lt))) consider(lt);
  consider(dataImageHoldStart(buf));
  consider(trailingSuggestionRunStart(buf));
  consider(mermaidHoldStart(buf));

  return hold;
}

// Strip CLOSED mermaid/mmd fences. The bulk `stripRenderedMermaidCode` also
// trims and collapses blank lines, but that cosmetic cleanup would corrupt
// streamed chunk boundaries, so it is intentionally dropped here.
function stripClosedMermaidFences(text: string): string {
  return text.replace(CLOSED_MERMAID_FENCE, "");
}

export function makeTextSink(ctx: TextSinkContext): TextSink {
  // Withheld text not yet safe to emit (incomplete tag / fence / paired-pipe).
  let pending = "";
  // Once a real `<suggestions>` open tag is seen, everything from it onward is
  // held verbatim and parsed at the final dispatch via takeSuggestions().
  let suggestionsMode = false;
  let suggestionsHold = "";
  // Buffer used only while a deferred answer artifact waits to be woven: the
  // lead-in text is held until a paragraph break (the weave point) or stream
  // end, so the artifact never lands mid-sentence.
  let weaveBuf = "";
  let artifactsWoven = false;
  // True once any answer artifact was deferred this turn — gates the mermaid
  // strip (mirrors the bulk path running stripRenderedMermaidCode only when an
  // artifact is present).
  let everHadArtifacts = false;
  let emitted = false;

  function flushArtifacts(): SSEEvent[] {
    const out: SSEEvent[] = [];
    while (ctx.deferredAnswerArtifactEvents.length > 0) {
      out.push(ctx.deferredAnswerArtifactEvents.shift()!);
      ctx.onArtifactEmitted();
    }
    artifactsWoven = true;
    return out;
  }

  function chunk(text: string): SSEEvent {
    emitted = true;
    return streamingMessageChunk(text);
  }

  // splitForArtifactInsertion fallback (no paragraph boundary): split after a
  // sentence (40–280 chars) or, failing that, place the artifact first. Folded
  // in from loop.ts so the sink is the single owner of artifact ordering.
  function splitForArtifactInsertion(text: string): { before: string; after: string } {
    const paragraph = PARAGRAPH_BREAK.exec(text);
    if (paragraph && paragraph.index > 0) {
      const splitAt = paragraph.index + paragraph[0].length;
      return { before: text.slice(0, splitAt), after: text.slice(splitAt) };
    }
    const sentence = /^([\s\S]{40,280}?[.!?])\s+/.exec(text);
    if (sentence?.[1]) {
      return { before: text.slice(0, sentence[0].length), after: text.slice(sentence[0].length) };
    }
    return { before: "", after: text };
  }

  // Emit a strip-safe span (guaranteed to contain no incomplete pattern). When
  // an answer artifact is pending, buffer until a paragraph break (weave) or
  // `final`; otherwise stream immediately.
  function emitSafe(rawSafe: string, final: boolean): SSEEvent[] {
    if (ctx.deferredAnswerArtifactEvents.length > 0) everHadArtifacts = true;

    let clean = stripPlaceholderTags(rawSafe);
    if (everHadArtifacts) clean = stripClosedMermaidFences(clean);

    const artifactPending = ctx.deferredAnswerArtifactEvents.length > 0 && !artifactsWoven;
    const events: SSEEvent[] = [];

    if (artifactPending) {
      weaveBuf += clean;
      const para = PARAGRAPH_BREAK.exec(weaveBuf);
      if (para && para.index > 0) {
        const splitAt = para.index + para[0].length;
        const before = weaveBuf.slice(0, splitAt);
        const after = weaveBuf.slice(splitAt);
        weaveBuf = "";
        if (before) events.push(chunk(before));
        events.push(...flushArtifacts());
        if (after) events.push(chunk(after)); // artifact woven — rest streams live
        return events;
      }
      if (final) {
        const { before, after } = splitForArtifactInsertion(weaveBuf);
        weaveBuf = "";
        if (before) events.push(chunk(before));
        events.push(...flushArtifacts());
        if (after) events.push(chunk(after));
        return events;
      }
      return events; // held until the weave point
    }

    if (clean) events.push(chunk(clean));
    return events;
  }

  function pushDelta(text: string): SSEEvent[] {
    if (suggestionsMode) {
      suggestionsHold += text;
      return [];
    }
    pending += text;

    const open = SUGGESTIONS_OPEN.exec(pending);
    if (open) {
      const before = pending.slice(0, open.index);
      suggestionsHold = pending.slice(open.index);
      pending = "";
      suggestionsMode = true;
      return emitSafe(before, true); // flush the prose before the block
    }

    const hold = computeHoldStart(pending);
    let safe = pending.slice(0, hold);
    pending = pending.slice(hold);
    if (pending.length > MAX_HOLD) {
      safe += pending;
      pending = "";
    }
    return emitSafe(safe, false);
  }

  function flushTail(): SSEEvent[] {
    if (suggestionsMode) {
      // Prose before the block already streamed on switch; emit any artifacts
      // that never found a weave point.
      return ctx.deferredAnswerArtifactEvents.length > 0 ? flushArtifacts() : [];
    }
    const out = emitSafe(pending, true);
    pending = "";
    return out;
  }

  function takeSuggestions(): { cleanTail: string; suggestions: string[] } {
    if (!suggestionsMode) return { cleanTail: "", suggestions: [] };
    const { cleanText, suggestions } = parseSuggestions(suggestionsHold);
    return { cleanTail: stripPlaceholderTags(cleanText), suggestions };
  }

  return {
    pushDelta,
    flushTail,
    takeSuggestions,
    get textEmitted() {
      return emitted;
    },
  };
}

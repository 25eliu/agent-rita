/**
 * Test helpers for the Vercel AI SDK v6 MockLanguageModelV3.
 *
 * The agent loop calls `streamText` (→ `doStream`); the `/generate` routes
 * and `singleShotLlm` call `generateText` (→ `doGenerate`). Each factory
 * implements BOTH from the same scripted spec so a test driving either path
 * gets identical behavior without a real provider.
 *
 * Tool-call inputs MUST be JSON-stringified per V3 spec — pass plain
 * objects to the helpers and they're serialized for you.
 */

import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream, type LanguageModel } from "ai";
import type {
  LanguageModelV3,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

export type ToolCallSpec = {
  toolCallId?: string;
  toolName: string;
  input: unknown;
};

export type LlmStep = {
  text?: string;
  /**
   * Emit the assistant text as a SEQUENCE of provider-level `text-delta` parts
   * (one text block, many deltas) so the loop's incremental tag-strip / sink
   * state machine is exercised with the same tag split across delta boundaries.
   * `doGenerate` joins them; takes precedence over `text` when present.
   */
  textDeltas?: string[];
  toolCalls?: ToolCallSpec[];
  finishReason?: "stop" | "tool-calls" | "length" | "content-filter" | "error";
};

function stepText(step: LlmStep): string | undefined {
  if (step.textDeltas != null) return step.textDeltas.join("");
  return step.text;
}

const DEFAULT_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
  totalTokens: 2,
};

function unifiedFinish(
  finishReason: LlmStep["finishReason"],
  hasToolCalls: boolean,
): LanguageModelV3FinishReason {
  const u = finishReason ?? (hasToolCalls ? "tool-calls" : "stop");
  return { unified: u, raw: u };
}

function buildResult(step: LlmStep): LanguageModelV3GenerateResult {
  const content: LanguageModelV3Content[] = [];
  const text = stepText(step);
  if (text != null) content.push({ type: "text", text });
  let toolCallIdx = 0;
  for (const tc of step.toolCalls ?? []) {
    content.push({
      type: "tool-call",
      toolCallId: tc.toolCallId ?? `c${++toolCallIdx}`,
      toolName: tc.toolName,
      input: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input),
    });
  }
  return {
    content,
    finishReason: unifiedFinish(step.finishReason, (step.toolCalls?.length ?? 0) > 0),
    usage: DEFAULT_USAGE,
    warnings: [],
  } as unknown as LanguageModelV3GenerateResult;
}

/**
 * Provider-level stream form of a step, for `doStream` (consumed by the loop's
 * `streamText`). Text rides one text-start/delta/end segment so the loop's
 * per-block buffering + whole-segment tag strip is exercised faithfully; tool
 * calls follow, then a single finish part.
 */
function buildStream(step: LlmStep): { stream: ReadableStream<LanguageModelV3StreamPart> } {
  const chunks: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];
  const textParts = step.textDeltas ?? (step.text != null ? [step.text] : null);
  if (textParts != null) {
    chunks.push({ type: "text-start", id: "t0" });
    for (const part of textParts) {
      chunks.push({ type: "text-delta", id: "t0", delta: part });
    }
    chunks.push({ type: "text-end", id: "t0" });
  }
  let toolCallIdx = 0;
  for (const tc of step.toolCalls ?? []) {
    chunks.push({
      type: "tool-call",
      toolCallId: tc.toolCallId ?? `c${++toolCallIdx}`,
      toolName: tc.toolName,
      input: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input),
    });
  }
  chunks.push({
    type: "finish",
    finishReason: unifiedFinish(step.finishReason, (step.toolCalls?.length ?? 0) > 0),
    usage: DEFAULT_USAGE,
  });
  return { stream: simulateReadableStream({ chunks }) };
}

export function makeMockLlm(step: LlmStep): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: async () => buildResult(step),
    doStream: async () => buildStream(step),
  } as unknown as ConstructorParameters<typeof MockLanguageModelV3>[0]) as unknown as LanguageModel;
}

export function makeErroringStreamMockLlm(error: unknown): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: async () => buildResult({ finishReason: "error" }),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "error", error } as unknown as LanguageModelV3StreamPart,
        ],
      }),
    }),
  } as unknown as ConstructorParameters<typeof MockLanguageModelV3>[0]) as unknown as LanguageModel;
}

/**
 * Sequenced mock: each call to doGenerate returns the next step. After the
 * sequence is exhausted the last step is replayed (matches a model that has
 * "made up its mind" and stops emitting fresh tool calls).
 */
export function makeSequencedMockLlm(steps: LlmStep[]): LanguageModel {
  // Independent cursors: the loop drives `doStream`, /generate paths drive
  // `doGenerate`. Each call (one streamText / one generateText) advances its
  // own cursor; after exhaustion the last step replays.
  let genIdx = 0;
  let streamIdx = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => buildResult(steps[Math.min(genIdx++, steps.length - 1)]),
    doStream: async () => buildStream(steps[Math.min(streamIdx++, steps.length - 1)]),
  } as unknown as ConstructorParameters<typeof MockLanguageModelV3>[0]) as unknown as LanguageModel;
}

/**
 * Capture the inputs passed to doGenerate. Useful for asserting that the
 * tools surfaced to the model never contain `x-agentrita-*` keys, etc.
 */
export interface SpyMockLlm {
  model: LanguageModel;
  calls: Array<{ tools?: Record<string, unknown>; messages?: unknown }>;
}

export function makeSpyMockLlm(step: LlmStep): SpyMockLlm {
  const calls: SpyMockLlm["calls"] = [];
  const capture = (opts: Record<string, unknown>) =>
    calls.push({ tools: opts.tools as Record<string, unknown>, messages: opts.prompt });
  const model = new MockLanguageModelV3({
    doGenerate: async (opts: Record<string, unknown>) => {
      capture(opts);
      return buildResult(step);
    },
    doStream: async (opts: Record<string, unknown>) => {
      capture(opts);
      return buildStream(step);
    },
  } as unknown as ConstructorParameters<typeof MockLanguageModelV3>[0]) as unknown as LanguageModel;
  return { model, calls };
}

export function makeSequencedSpyMockLlm(steps: LlmStep[]): SpyMockLlm {
  const calls: SpyMockLlm["calls"] = [];
  const capture = (opts: Record<string, unknown>) =>
    calls.push({ tools: opts.tools as Record<string, unknown>, messages: opts.prompt });
  let genIdx = 0;
  let streamIdx = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts: Record<string, unknown>) => {
      capture(opts);
      return buildResult(steps[Math.min(genIdx++, steps.length - 1)]);
    },
    doStream: async (opts: Record<string, unknown>) => {
      capture(opts);
      return buildStream(steps[Math.min(streamIdx++, steps.length - 1)]);
    },
  } as unknown as ConstructorParameters<typeof MockLanguageModelV3>[0]) as unknown as LanguageModel;
  return { model, calls };
}

// ----- presets -----

export function llmEmitsText(text: string): LlmStep {
  return { text, finishReason: "stop" };
}

/**
 * Like `llmEmitsText` but streams the text across multiple provider `text-delta`
 * parts. Drives the split-tag case for the streaming sink: a placeholder tag (or
 * `<suggestions>` block, or base64 image) split across delta boundaries must
 * still be stripped/held correctly. `doGenerate` sees the joined text.
 */
export function llmEmitsTextInDeltas(parts: string[]): LlmStep {
  return { textDeltas: parts, finishReason: "stop" };
}

export function llmCallsTool(toolName: string, input: unknown): LlmStep {
  return { toolCalls: [{ toolName, input }], finishReason: "tool-calls" };
}

export function llmCallsToolWithText(
  toolName: string,
  input: unknown,
  text: string,
): LlmStep {
  return { text, toolCalls: [{ toolName, input }], finishReason: "tool-calls" };
}

// Suppress unused import warning — the V3 type is used implicitly by the
// MockLanguageModelV3 constructor signature, but TS may flag it as unused.
export type _LanguageModelV3 = LanguageModelV3;

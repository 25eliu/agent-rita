/**
 * Streaming-behavior cases (Tier 3, real LLM).
 *
 *  - no-preamble-before-tool: guards the live-streaming regression (gap #2) —
 *    streamed text can't be retracted, so the model must not emit user-visible
 *    prose BEFORE its first tool call. Near-invariant (passRate 0.9).
 *
 *  - suggest-followups-call-rate: SPIKE measuring how reliably a real model
 *    calls suggest_followups when instructed (suggestionsVia: "tool"). The
 *    case's observedRate in summary.json IS the call-rate. NOTE: trace.ts is
 *    single-shot (stops at the first round-trip), and suggest_followups fires
 *    at the END of a turn — so the prompt is KNOWLEDGE-ONLY to complete in one
 *    shot; a data prompt would round-trip and the trace would end before the
 *    tool call, understating the rate.
 */

import type { EvalCase } from "../runner";
import { techWorkspace } from "../fixtures/workspaces";
import { noPreambleLeak, noBadState, toolCalled } from "../graders";

export const streamingCases: EvalCase[] = [
  {
    id: "no-preamble-before-tool",
    description:
      "Model must not stream prose before its first tool call (live-stream regression guard)",
    messages: [
      {
        role: "human",
        content: "What's the latest revenue for the companies on my dashboard?",
      },
    ],
    workspace: techWorkspace,
    trials: 5,
    passRate: 0.9,
    graders: [noPreambleLeak(), noBadState()],
  },
  {
    id: "suggest-followups-call-rate",
    description:
      "SPIKE: how often the model calls suggest_followups when instructed (suggestionsVia=tool). observedRate = call-rate.",
    messages: [
      {
        role: "human",
        content: "In one or two sentences, what is a P/E ratio and why does it matter?",
      },
    ],
    workspace: techWorkspace,
    promptSuggestionsEnabled: true,
    suggestionsVia: "tool",
    trials: 5,
    // Lenient floor so the spike never gates CI — the real signal is observedRate
    // (the call-rate), read from summary.json. ≥0.95 is the bar to greenlight the
    // Part-C migration (it must beat the always-on trained inline block).
    passRate: 0.2,
    graders: [toolCalled("suggest_followups"), noBadState()],
  },
];

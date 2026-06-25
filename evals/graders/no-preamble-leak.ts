import type { Trace } from "../trace";
import type { GraderSpec } from "./index";

// Index of the first tool-call signal in the ordered event stream. Round-trip
// tools emit `copilotFunctionCall`; in-process tools (search_widgets,
// execute_sql, create_artifact) ride `copilotStatusUpdate` with a structured
// tool_call/details — mirror trace.ts's extractToolCalls so the boundary is
// detected for BOTH kinds (a grader keyed only on copilotFunctionCall would
// no-op on the common in-process-tool case).
function firstToolCallIndex(events: Trace["events"]): number {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.event === "copilotFunctionCall") return i;
    if (e.event === "copilotStatusUpdate") {
      const data = e.data as {
        tool_call?: { tool_name?: string };
        details?: Array<{ tool_name?: string }> | { tool_name?: string };
      };
      if (data.tool_call?.tool_name) return i;
      const details = Array.isArray(data.details)
        ? data.details
        : data.details
          ? [data.details]
          : [];
      if (details.some((d) => d?.tool_name)) return i;
    }
  }
  return -1;
}

function firstVisibleChunkIndex(events: Trace["events"]): number {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (
      e.event === "copilotMessageChunk" &&
      ((e.data as { delta?: string }).delta ?? "").trim().length > 0
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Invariant: the model must not stream user-visible prose BEFORE its first tool
 * call. Streamed text can't be retracted (the regression this guards), so a
 * preamble like "Let me check…" emitted ahead of a tool call leaks to the user.
 *
 * Purely POSITIONAL — no content/word heuristic — so a legitimate final answer
 * (which always comes AFTER the tools) never false-fails. A turn with no tool
 * call can't leak a preamble, so it passes.
 */
export function noPreambleLeak(): GraderSpec {
  return {
    name: "noPreambleLeak",
    grader: (trace: Trace) => {
      const tool = firstToolCallIndex(trace.events);
      if (tool < 0) return { pass: true, message: "no tool call — no preamble possible" };
      const chunk = firstVisibleChunkIndex(trace.events);
      if (chunk >= 0 && chunk < tool) {
        const leaked = (trace.events[chunk].data as { delta?: string }).delta ?? "";
        return {
          pass: false,
          message: `visible prose streamed before the first tool call: ${JSON.stringify(leaked.slice(0, 80))}`,
        };
      }
      return { pass: true, message: "no pre-tool prose" };
    },
  };
}

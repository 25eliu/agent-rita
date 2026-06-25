/**
 * Grader: assert the next round-trip SSE re-bakes a stashed citation id
 * into `extra_state.intermediate_citations`. Reads raw events from the
 * trace because per-call `parameters` doesn't expose extra_state.
 *
 * Use when an eval case starts with a prior tool message carrying
 * `intermediate_citations` — this verifies the loop preserves them on
 * the next emit instead of dropping silently.
 */

import type { Trace } from "../trace";
import type { GraderSpec } from "./index";
import type { SSEEvent } from "../../src/protocol/types";

interface ExtraStateShape {
  intermediate_citations?: Array<{ id?: string }>;
}

interface CallShape {
  function: string;
  extra_state?: ExtraStateShape;
}

export function intermediateCitationContains(id: string): GraderSpec {
  return {
    name: `intermediateCitationContains(${id})`,
    grader: (trace: Trace) => {
      for (const event of trace.events as SSEEvent[]) {
        if (event.event !== "copilotFunctionCall") continue;
        const data = event.data as unknown as CallShape;
        const cits = data.extra_state?.intermediate_citations ?? [];
        if (cits.some((c) => c.id === id)) {
          return {
            pass: true,
            message: `${data.function} extra_state.intermediate_citations contains "${id}"`,
          };
        }
      }
      // Also check terminal collection (no extra_state, lives on its own
      // event so the round-trip emit assertion above is still primary).
      for (const event of trace.events as SSEEvent[]) {
        if (event.event !== "copilotCitationCollection") continue;
        const cits = (event.data as { citations?: Array<{ id?: string }> }).citations ?? [];
        if (cits.some((c) => c.id === id)) {
          return {
            pass: true,
            message: `terminal citationCollection contains "${id}"`,
          };
        }
      }
      return {
        pass: false,
        message: `no emit carried citation "${id}" — re-POST plumbing dropped it`,
      };
    },
  };
}

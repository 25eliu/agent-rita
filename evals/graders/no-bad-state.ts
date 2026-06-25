import type { Trace } from "../trace";
import type { GraderSpec } from "./index";

/**
 * Invariant grader. These properties must NEVER hold; any violation fails
 * the case. Per the eval flake budget: invariants gate at pass-rate
 * 0.95+.
 */
export function noBadState(): GraderSpec {
  return {
    name: "noBadState",
    grader: (trace: Trace) => {
      // Invariant 1: COMPUTE_PERMANENTLY_UNAVAILABLE must not surface in
      // the model's text output (only as a tool error message).
      const blob = trace.finalText;
      if (blob.includes("COMPUTE_PERMANENTLY_UNAVAILABLE")) {
        return {
          pass: false,
          message: "Model surfaced COMPUTE_PERMANENTLY_UNAVAILABLE in final text",
        };
      }

      // Invariant 2: x-agentrita-* must never appear in the model's text.
      if (blob.includes("x-agentrita-")) {
        return {
          pass: false,
          message: "Model leaked x-agentrita-* into the final text",
        };
      }

      // Invariant 3: errors during execution should not pass silently.
      if (trace.errored) {
        return {
          pass: false,
          message: `Loop errored: ${trace.errorMessage ?? "unknown"}`,
        };
      }

      return { pass: true, message: "no invariants violated" };
    },
  };
}

import type { Trace } from "../trace";
import type { GraderSpec } from "./index";

/**
 * Pass if a tool call to `name` has parameters whose stringified payload
 * contains every term in `terms`. Useful for asserting "execute_sql call
 * mentions NVDA, AAPL, MSFT" without pinning exact SQL.
 */
export function argContains(name: string, terms: string[]): GraderSpec {
  return {
    name: `argContains(${name}, [${terms.join(", ")}])`,
    grader: (trace: Trace) => {
      const matches = trace.toolCalls.filter(
        (c) => c.name === name || c.serverToolName === name,
      );
      if (matches.length === 0) {
        return { pass: false, message: `${name} not called` };
      }
      for (const match of matches) {
        const blob = JSON.stringify(match.parameters).toLowerCase();
        const missing = terms.filter((t) => !blob.includes(t.toLowerCase()));
        if (missing.length === 0) {
          return { pass: true, message: `${name} args contain all terms` };
        }
      }
      return {
        pass: false,
        message: `${name} args missing terms: ${terms.join(", ")}`,
      };
    },
  };
}

/**
 * Pass if a tool call to `name` has a parameter at the given path equal to
 * `expected` (deep-equal via JSON.stringify).
 */
export function argEquals(
  name: string,
  path: string,
  expected: unknown,
): GraderSpec {
  return {
    name: `argEquals(${name}, ${path})`,
    grader: (trace: Trace) => {
      const matches = trace.toolCalls.filter(
        (c) => c.name === name || c.serverToolName === name,
      );
      if (matches.length === 0) return { pass: false, message: `${name} not called` };
      const expectedStr = JSON.stringify(expected);
      for (const match of matches) {
        const value = path
          .split(".")
          .reduce<unknown>(
            (acc, key) =>
              acc != null && typeof acc === "object"
                ? (acc as Record<string, unknown>)[key]
                : undefined,
            match.parameters,
          );
        if (JSON.stringify(value) === expectedStr) {
          return { pass: true, message: `${name}.${path} matches expected` };
        }
      }
      return {
        pass: false,
        message: `${name}.${path} did not match expected ${expectedStr}`,
      };
    },
  };
}

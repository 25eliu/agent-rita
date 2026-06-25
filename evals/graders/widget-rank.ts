import type { Trace } from "../trace";
import type { GraderSpec } from "./index";

/**
 * For evals that surface widgets through a search-then-fetch flow, this
 * grader inspects the get_widget_data call (which carries widget_uuid)
 * and asserts that one of the expected widget UUIDs is among the top-N
 * widgets the model chose.
 *
 * For deeper "search_widgets returned X in top-N" grading we'd need to
 * intercept the local execute() result — left as a follow-up.
 */
export function widgetIdInTopN(args: {
  expected: string;
  n?: number;
}): GraderSpec {
  return {
    name: `widgetIdInTopN(${args.expected}, n=${args.n ?? 3})`,
    grader: (trace: Trace) => {
      const limit = args.n ?? 3;
      const dataCall = trace.toolCalls.find((c) => c.name === "get_widget_data");
      if (!dataCall) {
        return {
          pass: false,
          message: "get_widget_data not called — model never selected a widget",
        };
      }
      const widgets = (dataCall.parameters.data_sources ??
        dataCall.parameters.widgets ??
        []) as Array<Record<string, unknown>>;
      const uuids = widgets
        .slice(0, limit)
        .map((w) => (w.widget_uuid ?? w.uuid) as string | undefined)
        .filter((u): u is string => typeof u === "string");
      return uuids.includes(args.expected)
        ? { pass: true, message: `Top ${limit} included ${args.expected}` }
        : {
            pass: false,
            message: `Expected ${args.expected} in top ${limit}; got [${uuids.join(", ")}]`,
          };
    },
  };
}

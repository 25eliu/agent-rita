/**
 * Graders take a Trace and return a GradeResult. Compose them per case.
 *
 * Per Anthropic's eval guidance: grade END-STATE, not exact tool order.
 * The agent regularly finds valid alternative paths.
 */

import type { Trace } from "../trace";

export interface GradeResult {
  pass: boolean;
  message: string;
}

export type Grader = (trace: Trace) => GradeResult | Promise<GradeResult>;

export interface GraderSpec {
  name: string;
  grader: Grader;
}

export { toolCalled, toolNeverCalled } from "./tool-called";
export { argContains, argEquals } from "./arg-contains";
export { widgetIdInTopN } from "./widget-rank";
export { noBadState } from "./no-bad-state";
export { noPreambleLeak } from "./no-preamble-leak";
export { llmJudge } from "./llm-judge";
export { intermediateCitationContains } from "./citations-persisted";

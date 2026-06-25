/**
 * Tier 3 — create_app behavior.
 *
 * Proves the model (a) discovers widgets via search_widgets and (b) assembles
 * them into an app via create_app using ONLY real (origin, widget_id) pairs
 * from the workspace — never invented ones. The last grader enforces the
 * "model never invents widget ids absent from search_widgets" invariant right
 * at the create_app boundary.
 *
 * Uses the real eval model; no mock LLM.
 */

import type { EvalCase } from "../runner";
import type { GraderSpec } from "../graders";
import { noBadState, toolCalled } from "../graders";
import { techWorkspace } from "../fixtures/workspaces";

const VALID_WIDGET_IDS = new Set(techWorkspace.primary.map((w) => w.widget_id));

// Every widget the model places in the app must be a real workspace widget.
const appWidgetRefsValid: GraderSpec = {
  name: "create_app refs in workspace (no hallucinated widget ids)",
  grader: (trace) => {
    const call = trace.toolCalls.find((c) => c.name === "create_app");
    if (!call) return { pass: false, message: "create_app not called" };
    const tabs =
      (call.parameters as { tabs?: { layout?: { widget_id?: string }[] }[] }).tabs ?? [];
    const refs = tabs.flatMap((t) => (t.layout ?? []).map((l) => l.widget_id ?? ""));
    if (refs.length === 0) return { pass: false, message: "create_app had no widget refs" };
    const invalid = refs.filter((id) => !VALID_WIDGET_IDS.has(id));
    return invalid.length === 0
      ? { pass: true, message: `all ${refs.length} widget refs are real` }
      : { pass: false, message: `invented widget ids: ${[...new Set(invalid)].join(", ")}` };
  },
};

export const appBuilderCases: EvalCase[] = [
  {
    id: "build-dashboard-uses-real-widgets",
    description:
      "User asks to build an Apple dashboard. The model should discover widgets via " +
      "search_widgets and assemble them with create_app using only real (origin, widget_id) pairs.",
    messages: [
      {
        role: "human",
        content:
          "Build me an Apple dashboard with the price history, earnings, and news side by side.",
      },
    ],
    workspace: techWorkspace,
    trials: 5,
    passRate: 0.6,
    graders: [
      toolCalled("search_widgets"),
      toolCalled("create_app"),
      appWidgetRefsValid,
      noBadState(),
    ],
  },
];

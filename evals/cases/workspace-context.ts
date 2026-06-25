/**
 * Workspace-context cases. Verify the model uses workspace_state +
 * SECONDARY widgets to resolve "this dashboard" / "show me earnings" /
 * deictic references.
 *
 * The fixture supplies SECONDARY widgets to mirror what the workspace
 * sends when the user is viewing a dashboard.
 */

import type { EvalCase } from "../runner";
import {
  techWorkspace,
  aaplDashboardState,
  macroDashboardState,
  macroWorkspace,
} from "../fixtures/workspaces";
import {
  argContains,
  llmJudge,
  noBadState,
  toolCalled,
  widgetIdInTopN,
  type GraderSpec,
} from "../graders";

const sectorDashboardWorkspace = {
  primary: [],
  secondary: [
    {
      uuid: "coverage-universe",
      origin: "openbb",
      widget_id: "coverage_universe",
      name: "Coverage Universe",
      description: "Coverage universe filtered by sector.",
      params: [
        {
          name: "sector",
          type: "string",
          description: "Sector option value",
          current_value: "healthcare",
        },
      ],
    },
    {
      uuid: "recommendation-mix",
      origin: "openbb",
      widget_id: "recommendation_mix",
      name: "Recommendation Mix",
      description: "Recommendation mix filtered by sector.",
      params: [
        {
          name: "sector",
          type: "string",
          description: "Sector option value",
          current_value: "healthcare",
        },
      ],
    },
    {
      uuid: "analyst-note",
      origin: "openbb",
      widget_id: "rich_note",
      name: "Analyst Thesis Note",
      description: "Freeform analyst note without a sector parameter.",
      params: [],
    },
  ],
  extra: [],
};

const sectorDashboardState = {
  current_page_context: "dashboard" as const,
  current_dashboard_uuid: "dash-equity",
  current_dashboard_info: {
    id: "dash-equity",
    name: "Equity Research Workbench",
    current_tab_id: "coverage",
    tabs: [
      {
        tab_id: "coverage",
        widgets: [
          { widget_uuid: "coverage-universe", name: "Coverage Universe" },
          { widget_uuid: "recommendation-mix", name: "Recommendation Mix" },
          { widget_uuid: "analyst-note", name: "Analyst Thesis Note" },
        ],
      },
    ],
  },
};

function safeSectorUpdate(): GraderSpec {
  return {
    name: "safeSectorUpdate",
    grader: (trace) => {
      const updateCalls = trace.toolCalls.filter((c) => c.name === "update_widget");
      if (updateCalls.length === 0) {
        return { pass: false, message: "did not call update_widget" };
      }

      const allowedWidgets = new Set(["coverage-universe", "recommendation-mix"]);
      const targetWidgets = updateCalls.map((c) => c.parameters.widget_uuid);
      const badTargets = updateCalls
        .map((c) => c.parameters.widget_uuid)
        .filter((uuid) => typeof uuid !== "string" || !allowedWidgets.has(uuid));
      if (badTargets.length > 0) {
        return {
          pass: false,
          message: `updated widgets without a sector parameter: ${badTargets.join(", ")}`,
        };
      }
      const missingTargets = [...allowedWidgets].filter((uuid) => !targetWidgets.includes(uuid));
      if (missingTargets.length > 0) {
        return {
          pass: false,
          message: `did not update all widgets with a sector parameter: ${missingTargets.join(", ")}`,
        };
      }

      const badValues = updateCalls
        .map((c) => {
          const config = c.parameters.config as { data_args?: Record<string, unknown> } | undefined;
          return config?.data_args?.sector;
        })
        .filter((value) => value !== "technology");
      if (badValues.length > 0) {
        return {
          pass: false,
          message: `sector values were not exact option/literal value "technology": ${badValues.join(", ")}`,
        };
      }

      return { pass: true, message: "sector updates target eligible widgets with exact values" };
    },
  };
}

// User names ONE widget ("on recommendation mix") — the update must hit that
// widget only, with the exact value. Updating the other sector widget too means
// the model ignored the user's scope. The prompt also sanctions inspecting the
// target (get_widget_schema/read_widget) before updating; that round-trips, and
// this single-turn harness can't follow it, so a first-turn inspection of the
// NAMED widget counts as correctly engaging the update path.
function namedWidgetSectorUpdate(expectedValue: string): GraderSpec {
  return {
    name: "namedWidgetSectorUpdate",
    grader: (trace) => {
      const updateCalls = trace.toolCalls.filter((c) => c.name === "update_widget");
      if (updateCalls.length === 0) {
        const inspectedNamedWidget = trace.toolCalls.some(
          (c) =>
            (c.name === "get_widget_schema" || c.name === "read_widget") &&
            [c.parameters.widget_id, c.parameters.widget_uuid].some(
              (v) => v === "recommendation_mix" || v === "recommendation-mix",
            ),
        );
        if (inspectedNamedWidget) {
          return {
            pass: true,
            message: "inspected the named widget (inspect-then-update path, round-trip not simulated)",
          };
        }
        return { pass: false, message: "did not call update_widget or inspect the named widget" };
      }

      const badTargets = updateCalls
        .map((c) => c.parameters.widget_uuid)
        .filter((uuid) => uuid !== "recommendation-mix");
      if (badTargets.length > 0) {
        return {
          pass: false,
          message: `updated widgets outside the named target: ${badTargets.join(", ")}`,
        };
      }

      const badValues = updateCalls
        .map((c) => {
          const config = c.parameters.config as { data_args?: Record<string, unknown> } | undefined;
          return config?.data_args?.sector;
        })
        .filter((value) => value !== expectedValue);
      if (badValues.length > 0) {
        return {
          pass: false,
          message: `sector values were not "${expectedValue}": ${badValues.join(", ")}`,
        };
      }

      return { pass: true, message: "update scoped to the named widget with the exact value" };
    },
  };
}

const aaplDashboardWorkspace = {
  primary: [],
  secondary: techWorkspace.primary.filter((w) =>
    ["aapl-price", "aapl-earnings"].includes(w.uuid ?? ""),
  ),
  extra: techWorkspace.primary.filter(
    (w) => !["aapl-price", "aapl-earnings"].includes(w.uuid ?? ""),
  ),
};

const macroDashboardWorkspace = {
  primary: [],
  secondary: macroWorkspace.primary,
  extra: [],
};

export const workspaceContextCases: EvalCase[] = [
  {
    id: "deictic-show-earnings-on-aapl-dashboard",
    description:
      "User on AAPL dashboard says 'show me earnings' → resolves to AAPL Earnings widget, not asking to clarify",
    messages: [{ role: "human", content: "show me the earnings" }],
    workspace: aaplDashboardWorkspace,
    workspaceState: aaplDashboardState,
    trials: 3,
    passRate: 0.6,
    graders: [
      toolCalled("get_widget_data"),
      argContains("get_widget_data", ["aapl-earnings"]),
      noBadState(),
    ],
  },
  {
    id: "deictic-latest-data-on-macro-dashboard",
    description:
      "User on macro dashboard says 'what's the latest data?' → resolves to one of CPI/GDP/unemployment",
    messages: [{ role: "human", content: "what's the latest data?" }],
    workspace: macroDashboardWorkspace,
    workspaceState: macroDashboardState,
    trials: 3,
    passRate: 0.5,
    graders: [
      toolCalled("get_widget_data"),
      llmJudge({
        criterion:
          "The agent fetched data from one of the macro widgets visible on the user's current dashboard (CPI, GDP, or unemployment) instead of asking the user to clarify.",
        threshold: 0.6,
      }),
      noBadState(),
    ],
  },
  {
    id: "primary-over-secondary-explicit-symbol",
    description:
      "On AAPL dashboard, asking about NVDA earnings → fetches the NVDA widget from EXTRA tier (via search_widgets) OR directly if the model can recall the UUID. Either way, the request must surface 'nvda-earnings'.",
    messages: [{ role: "human", content: "how about NVIDIA's last earnings?" }],
    workspace: aaplDashboardWorkspace,
    workspaceState: aaplDashboardState,
    trials: 3,
    passRate: 0.5,
    graders: [
      widgetIdInTopN({ expected: "nvda-earnings", n: 3 }),
      noBadState(),
    ],
  },
  {
    id: "dashboard-sector-parameter-update-uses-exact-value",
    description:
      "Dashboard parameter update should target only widgets with a sector param and use exact value 'technology', not display label 'Technology'.",
    messages: [{ role: "human", content: "update parameter sector to technology" }],
    workspace: sectorDashboardWorkspace,
    workspaceState: sectorDashboardState,
    generativeUiEnabled: true,
    trials: 3,
    passRate: 0.6,
    graders: [
      safeSectorUpdate(),
      noBadState(),
    ],
  },
  {
    id: "dashboard-sector-parameter-update-named-widget",
    description:
      "Parameter update naming one widget by its display name (without the word 'widget') → update_widget scoped to that widget only.",
    messages: [
      { role: "human", content: "update parameter sector to energy on recommendation mix" },
    ],
    workspace: sectorDashboardWorkspace,
    workspaceState: sectorDashboardState,
    generativeUiEnabled: true,
    trials: 3,
    passRate: 0.6,
    graders: [
      namedWidgetSectorUpdate("energy"),
      noBadState(),
    ],
  },
];

void macroDashboardState;
void toolCalled;

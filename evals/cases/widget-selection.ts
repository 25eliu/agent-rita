/**
 * Widget-selection cases. Validates that the model picks the right
 * widget(s) from a workspace before fetching data.
 */

import type { EvalCase } from "../runner";
import { techWorkspace, macroWorkspace } from "../fixtures/workspaces";
import { widgetIdInTopN, noBadState } from "../graders";

// All cases here use widgets in the PRIMARY tier — already in the system
// prompt. Model is not expected to call search_widgets first; it should
// jump straight to get_widget_data with the right UUID. search_widgets
// is for the EXTRA tier (covered in workspace-context cases).
export const widgetSelectionCases: EvalCase[] = [
  {
    id: "aapl-price-history",
    description: "Apple stock price → AAPL price history widget",
    messages: [{ role: "human", content: "show me Apple's stock price for the last month" }],
    workspace: techWorkspace,
    trials: 3,
    passRate: 0.7,
    graders: [widgetIdInTopN({ expected: "aapl-price", n: 3 }), noBadState()],
  },
  {
    id: "nvda-earnings",
    description: "NVIDIA earnings → NVDA earnings widget",
    messages: [{ role: "human", content: "what were NVIDIA's last quarterly earnings?" }],
    workspace: techWorkspace,
    trials: 3,
    passRate: 0.7,
    graders: [widgetIdInTopN({ expected: "nvda-earnings", n: 3 }), noBadState()],
  },
  {
    id: "us-inflation",
    description: "US inflation → US CPI macro widget",
    messages: [{ role: "human", content: "what's the latest US inflation reading?" }],
    workspace: macroWorkspace,
    trials: 3,
    passRate: 0.7,
    graders: [widgetIdInTopN({ expected: "us-cpi", n: 3 }), noBadState()],
  },
  {
    id: "tech-news",
    description: "Tech news headlines → Tech Sector News widget",
    messages: [{ role: "human", content: "any big tech news today?" }],
    workspace: techWorkspace,
    trials: 3,
    passRate: 0.6,
    graders: [widgetIdInTopN({ expected: "tech-news", n: 3 }), noBadState()],
  },
  {
    id: "msft-price-snapshot",
    description: "Microsoft current price → MSFT price history widget",
    messages: [{ role: "human", content: "how much is MSFT trading at right now?" }],
    workspace: techWorkspace,
    trials: 3,
    passRate: 0.7,
    graders: [widgetIdInTopN({ expected: "msft-price", n: 3 }), noBadState()],
  },
];

/**
 * Skills cases — autonomous mid-turn skill loading.
 *
 * Verifies the model recognizes when a skill description matches the user's
 * topic and calls `get_skill_content` proactively, without a `/skill:slug`
 * prefix. Also pins the negative case: irrelevant skills must NOT be loaded.
 *
 * The eval runner cuts at the first round-trip emit, so each case grades
 * what the model picked first, not the eventual answer.
 */

import type { EvalCase } from "../runner";
import type { SkillCatalogEntry } from "../../src/protocol/types";
import { techWorkspace } from "../fixtures/workspaces";
import { toolCalled, toolNeverCalled, argContains, noBadState } from "../graders";

const OPTIONS_SKILL: SkillCatalogEntry = {
  slug: "options-trading",
  description:
    "Options pricing, Greeks (delta, gamma, theta, vega), implied volatility, and strategy construction (spreads, straddles).",
  updatedAt: "2026-01-01",
};

const RISK_SKILL: SkillCatalogEntry = {
  slug: "risk-management",
  description:
    "Portfolio risk frameworks: VaR, CVaR, drawdown analysis, position sizing, hedging strategies.",
  updatedAt: "2026-01-01",
};

const PORTFOLIO_SKILL: SkillCatalogEntry = {
  slug: "portfolio-construction",
  description:
    "Asset allocation, mean-variance optimization, factor exposure, rebalancing rules, and benchmark selection.",
  updatedAt: "2026-01-01",
};

const EARNINGS_SKILL: SkillCatalogEntry = {
  slug: "earnings-analysis",
  description:
    "Quarterly earnings interpretation, EPS surprise analysis, guidance reading, conference-call insights.",
  updatedAt: "2026-01-01",
};

const TAX_SKILL: SkillCatalogEntry = {
  slug: "tax-optimization",
  description: "Tax-loss harvesting, wash-sale rules, lot selection, capital gains planning.",
  updatedAt: "2026-01-01",
};

export const skillsCases: EvalCase[] = [
  {
    id: "skill-autonomous-load-options",
    description:
      "User asks options pricing question; matching skill in catalog — model should call get_skill_content('options-trading') autonomously",
    messages: [
      {
        role: "human",
        content:
          "What's the gamma of an at-the-money call expiring in 30 days at 25% implied volatility?",
      },
    ],
    workspace: techWorkspace,
    skillsCatalog: [OPTIONS_SKILL, RISK_SKILL, PORTFOLIO_SKILL, EARNINGS_SKILL, TAX_SKILL],
    trials: 5,
    passRate: 0.6,
    graders: [
      toolCalled("get_skill_content"),
      argContains("get_skill_content", ["options-trading"]),
      noBadState(),
    ],
  },
  {
    id: "skill-no-load-on-mismatch",
    description:
      "User asks unrelated weather question; skills catalog has no match — model should NOT load any skill",
    messages: [
      { role: "human", content: "what's the weather like in Lisbon today?" },
    ],
    workspace: techWorkspace,
    skillsCatalog: [OPTIONS_SKILL, RISK_SKILL, PORTFOLIO_SKILL, EARNINGS_SKILL, TAX_SKILL],
    trials: 5,
    passRate: 0.8,
    graders: [toolNeverCalled("get_skill_content"), noBadState()],
  },
  {
    id: "skill-multi-match-loads-relevant",
    description:
      "Position-sizing question spans risk-management and portfolio-construction — model should call get_skill_content at least once and the chosen slug should be one of the matching ones",
    messages: [
      {
        role: "human",
        content:
          "How should I size a 5% position in a high-beta tech stock given my 20% max drawdown rule?",
      },
    ],
    workspace: techWorkspace,
    skillsCatalog: [OPTIONS_SKILL, RISK_SKILL, PORTFOLIO_SKILL, EARNINGS_SKILL, TAX_SKILL],
    trials: 5,
    passRate: 0.6,
    graders: [
      toolCalled("get_skill_content"),
      {
        name: "argSlugIsRiskOrPortfolio",
        grader: (trace) => {
          const calls = trace.toolCalls.filter((c) => c.name === "get_skill_content");
          if (calls.length === 0) return { pass: false, message: "get_skill_content not called" };
          for (const call of calls) {
            const slug = (call.parameters.slug as string | undefined)?.toLowerCase() ?? "";
            if (slug === "risk-management" || slug === "portfolio-construction") {
              return { pass: true, message: `loaded skill="${slug}"` };
            }
          }
          const seen = calls.map((c) => c.parameters.slug).join(", ");
          return {
            pass: false,
            message: `expected risk-management or portfolio-construction, got: ${seen}`,
          };
        },
      },
      noBadState(),
    ],
  },
];

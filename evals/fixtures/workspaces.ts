/**
 * Hand-authored OpenBB widget fixture sets for evals.
 *
 * These mimic the shape of widgets that would arrive via /v1/query but
 * are intentionally tiny and stable so eval results are reproducible.
 * Refresh quarterly or when widget metadata shape changes upstream.
 */

import type { Widget } from "../../src/protocol/types";

export const techWorkspace: { primary: Widget[]; secondary: Widget[] } = {
  primary: [
    {
      uuid: "aapl-price",
      origin: "openbb",
      widget_id: "equity_price_history",
      name: "AAPL Price History",
      description: "Daily close prices for AAPL.",
      params: [
        { name: "symbol", type: "string", description: "Ticker symbol", current_value: "AAPL" },
        { name: "interval", type: "string", description: "Daily/Weekly", current_value: "1d" },
      ],
      category: "Equity",
      sub_category: "Price History",
    },
    {
      uuid: "nvda-price",
      origin: "openbb",
      widget_id: "equity_price_history",
      name: "NVDA Price History",
      description: "Daily close prices for NVDA.",
      params: [
        { name: "symbol", type: "string", description: "Ticker symbol", current_value: "NVDA" },
        { name: "interval", type: "string", description: "Daily/Weekly", current_value: "1d" },
      ],
      category: "Equity",
      sub_category: "Price History",
    },
    {
      uuid: "msft-price",
      origin: "openbb",
      widget_id: "equity_price_history",
      name: "MSFT Price History",
      description: "Daily close prices for MSFT.",
      params: [
        { name: "symbol", type: "string", description: "Ticker symbol", current_value: "MSFT" },
      ],
      category: "Equity",
      sub_category: "Price History",
    },
    {
      uuid: "aapl-earnings",
      origin: "openbb",
      widget_id: "equity_earnings",
      name: "AAPL Earnings",
      description: "Apple quarterly earnings: EPS, revenue, surprises.",
      params: [
        { name: "symbol", type: "string", description: "Ticker symbol", current_value: "AAPL" },
      ],
      category: "Equity",
      sub_category: "Fundamentals",
    },
    {
      uuid: "nvda-earnings",
      origin: "openbb",
      widget_id: "equity_earnings",
      name: "NVDA Earnings",
      description: "NVIDIA quarterly earnings: EPS, revenue, surprises.",
      params: [
        { name: "symbol", type: "string", description: "Ticker symbol", current_value: "NVDA" },
      ],
      category: "Equity",
      sub_category: "Fundamentals",
    },
    {
      uuid: "tech-news",
      origin: "openbb",
      widget_id: "company_news",
      name: "Tech Sector News",
      description: "Latest news headlines for major tech stocks.",
      params: [],
      category: "Equity",
      sub_category: "News",
    },
  ],
  secondary: [],
};

export const macroWorkspace: { primary: Widget[]; secondary: Widget[] } = {
  primary: [
    {
      uuid: "us-cpi",
      origin: "openbb",
      widget_id: "macro_cpi",
      name: "US CPI",
      description: "US Consumer Price Index — monthly readings.",
      params: [{ name: "country", type: "string", description: "Country code", current_value: "US" }],
      category: "Macro",
      sub_category: "Inflation",
    },
    {
      uuid: "us-gdp",
      origin: "openbb",
      widget_id: "macro_gdp",
      name: "US GDP",
      description: "US quarterly GDP releases.",
      params: [{ name: "country", type: "string", description: "Country code", current_value: "US" }],
      category: "Macro",
      sub_category: "Growth",
    },
    {
      uuid: "us-unemployment",
      origin: "openbb",
      widget_id: "macro_unemployment",
      name: "US Unemployment Rate",
      description: "Monthly US unemployment percentage.",
      params: [],
      category: "Macro",
      sub_category: "Labor",
    },
  ],
  secondary: [],
};

export const FIXTURES = {
  tech: techWorkspace,
  macro: macroWorkspace,
} as const;

export type FixtureKey = keyof typeof FIXTURES;

// Workspace-state fixtures — describe where the user currently is. Used
// to test whether the model resolves ambiguous "this", "the dashboard"
// references against the visible context.
import type { WorkspaceState } from "../../src/protocol/types";

export const aaplDashboardState: WorkspaceState = {
  current_page_context: "dashboard",
  current_dashboard_uuid: "dash-aapl",
  current_dashboard_info: {
    id: "dash-aapl",
    name: "AAPL Deep Dive",
    current_tab_id: "overview",
    tabs: [
      {
        tab_id: "overview",
        widgets: [
          { widget_uuid: "aapl-price", name: "AAPL Price History" },
          { widget_uuid: "aapl-earnings", name: "AAPL Earnings" },
        ],
      },
    ],
  },
};

export const macroDashboardState: WorkspaceState = {
  current_page_context: "dashboard",
  current_dashboard_uuid: "dash-macro",
  current_dashboard_info: {
    id: "dash-macro",
    name: "US Macro Pulse",
    current_tab_id: "overview",
    tabs: [
      {
        tab_id: "overview",
        widgets: [
          { widget_uuid: "us-cpi", name: "US CPI" },
          { widget_uuid: "us-gdp", name: "US GDP" },
        ],
      },
    ],
  },
};

export const homeState: WorkspaceState = {
  current_page_context: "home",
};

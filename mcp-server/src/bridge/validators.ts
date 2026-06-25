/**
 * Tool-side validators ported verbatim from workspace_mcp/server.py:198-408.
 *
 * Each function returns `null` when the payload is valid or a string error
 * message when it is not. Callers wrap the message in an errorItem.
 */

import { errorItem, type ContentItem } from "../lib/typed";

export function invalidRequestItem(message: string): ContentItem {
  return errorItem({
    code: "invalid_request",
    message,
    retryable: false,
  });
}

export function hasLayoutUiArgs(uiArgs: unknown): boolean {
  if (uiArgs === null || typeof uiArgs !== "object" || Array.isArray(uiArgs)) {
    return false;
  }
  const keys = new Set(Object.keys(uiArgs as Record<string, unknown>));
  const layoutKeys = [
    "x",
    "y",
    "w",
    "h",
    "min_w",
    "min_h",
    "max_w",
    "max_h",
    "minW",
    "minH",
    "maxW",
    "maxH",
    "grid_data",
    "gridData",
    "inner_tab",
    "innerTab",
  ];
  return layoutKeys.some((key) => keys.has(key));
}

export function isGenerativeOnlyWidget(widgetId: string): boolean {
  return widgetId === "rich_note";
}

/**
 * Mirrors workspace_mcp/server.py:310-333. Returns null when valid, or a
 * `ToolResponse`-shaped error with command set to "manage_navigation_bar".
 */
export function validateNavigationTabs(
  operation: string,
  tabs: Array<Record<string, unknown>>,
): string | null {
  if (!["create", "add_tabs", "remove_tabs"].includes(operation)) return null;

  for (const item of tabs) {
    if ("tab_id" in item || "tab_name" in item) {
      return (
        "manage_navigation_bar tabs_json items must not include tab_id or tab_name; " +
        'use only {"name":"AAPL Analysis"}. The tab_id is generated as the slug of name.'
      );
    }
    const name = item.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      return (
        "manage_navigation_bar tabs_json items must be objects with a non-empty string 'name' field, " +
        'for example [{"name":"AAPL Analysis"}]. Do not use tab_id/tab_name keys.'
      );
    }
  }

  return null;
}

/**
 * Mirrors workspace_mcp/server.py:365-408. Returns null when valid, or an
 * error message string ready to wrap in errorItem.
 */
export function validateAddGenerativeWidgetRequest(args: {
  widget_type: string;
  data: Array<Record<string, unknown>> | string | null;
  chart_params: Record<string, unknown> | null;
}): string | null {
  const { widget_type, data, chart_params } = args;

  if (widget_type === "note" || widget_type === "html") {
    if (typeof data !== "string") {
      return (
        `add_generative_widget with widget_type='${widget_type}' ` +
        "requires string data."
      );
    }
    return null;
  }

  if (!Array.isArray(data)) {
    return (
      `add_generative_widget with widget_type='${widget_type}' ` +
      "requires data as list[dict]."
    );
  }

  if (widget_type !== "chart") return null;

  if (chart_params === null || typeof chart_params !== "object") {
    return (
      "add_generative_widget with widget_type='chart' requires chart_params " +
      "with chartType, xKey, and non-empty yKey."
    );
  }

  const yKey = chart_params.yKey;
  if (
    typeof chart_params.chartType !== "string" ||
    typeof chart_params.xKey !== "string" ||
    !Array.isArray(yKey) ||
    yKey.length === 0 ||
    !yKey.every((k) => typeof k === "string")
  ) {
    return (
      "add_generative_widget with widget_type='chart' requires chart_params " +
      "with chartType, xKey, and non-empty yKey."
    );
  }

  return null;
}
